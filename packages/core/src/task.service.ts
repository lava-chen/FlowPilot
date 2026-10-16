import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor, CreateTaskDraftInput, Priority, Task, TaskStatus } from '@flowpilot/domain';
import { allowedTransitions, canTransition, findTransition } from '@flowpilot/domain';
import { InvalidTransitionError, newId, nowIso, ValidationError } from '@flowpilot/shared';
import type { AuditService } from './audit.service.js';
import type { WorkflowFactory } from './services.js';
import { assertCan } from './permissions.js';
import type { TaskOperationsService } from './task-operations.service.js';

/**
 * Every task write goes through this service.
 *
 * Note what is *absent*: there is no `setStatus(taskId, anything)`. Callers request a transition
 * and the domain state machine decides. That is why the Dashboard and the MCP server cannot
 * disagree about the rules even though they are separate processes.
 */
export class TaskService {
  constructor(
    private readonly db: FlowPilotDb,
    private readonly audit: AuditService,
    private readonly workflowsFor: WorkflowFactory,
    private readonly operations: TaskOperationsService,
  ) {}

  async createDraft(actor: Actor, input: CreateTaskDraftInput, options: { fromRequestId?: string } = {}): Promise<Task> {
    assertCan(actor, 'drafts:create');

    const project = await this.db.repos.projects.require(actor.orgId, input.projectId);

    if (input.assigneeId) {
      const membership = await this.db.repos.memberships.findByUser(actor.orgId, input.assigneeId);
      if (!membership) throw new ValidationError('The assignee must be a member of this organization.', { assigneeId: input.assigneeId });
    }

    const task = await this.db.repos.tasks.create({
      id: newId('task'),
      orgId: actor.orgId,
      projectId: project.id,
      requestId: input.requestId ?? options.fromRequestId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: 'draft',
      priority: input.priority,
      assigneeId: input.assigneeId ?? null,
      dueDate: input.dueDate ?? null,
      estimatedHours: input.estimatedHours ?? null,
      source: input.source,
      createdBy: actor.kind === 'user' ? actor.userId : actor.orgId,
    });

    if (task.requestId) {
      await this.db.repos.requests.setStatus(actor.orgId, task.requestId, 'drafted');
    }

    await this.audit.record(actor, 'task.draft_created', 'task', task.id, {
      title: task.title,
      projectId: project.id,
      projectCode: project.code,
      requestId: task.requestId,
      source: task.source,
    });

    return task;
  }

  /** Creates a draft straight from a request's AI analysis and opens the approval run. */
  async createDraftFromRequest(actor: Actor, requestId: string): Promise<Task> {
    assertCan(actor, 'drafts:create');

    const request = await this.db.repos.requests.require(actor.orgId, requestId);
    const analysis = request.analysis;
    if (!analysis) {
      throw new ValidationError('Analyze the request before creating a draft from it.', { requestId });
    }
    if (!analysis.projectId) {
      throw new ValidationError('The analysis did not resolve a project. Set a project on the request first.', {
        requestId,
      });
    }

    const existing = await this.db.repos.tasks.findByRequest(actor.orgId, requestId);
    if (existing.length > 0) {
      throw new ValidationError(`This request already produced ${existing.length} task draft(s).`, { requestId });
    }

    const task = await this.createDraft(actor, {
      projectId: analysis.projectId,
      requestId,
      title: analysis.title,
      description: analysis.description,
      priority: analysis.priority,
      assigneeId: analysis.suggestedAssignee?.userId ?? null,
      dueDate: analysis.dueDate,
      source: actor.kind === 'agent' ? 'agent' : 'human',
    });

    const workflows = this.workflowsFor(actor);
    const run = await workflows.start({
      trigger: actor.kind === 'agent' ? 'mcp' : 'manual',
      requestId,
      taskId: task.id,
      steps: [
        {
          key: 'draft',
          label: 'Create task draft',
          status: 'succeeded',
          startedAt: nowIso(),
          finishedAt: nowIso(),
          detail: { taskId: task.id, fromRequest: requestId, confidence: analysis.confidence },
          error: null,
        },
        {
          key: 'approval',
          label: 'Human approval',
          status: 'pending',
          startedAt: nowIso(),
          finishedAt: null,
          detail: null,
          error: null,
        },
      ],
    });
    await workflows.finish(run, 'waiting_approval');

    return task;
  }

  async list(
    actor: Actor,
    filter: { status?: TaskStatus[]; assigneeId?: string; projectId?: string; requestId?: string; limit: number },
  ): Promise<Task[]> {
    assertCan(actor, 'tasks:read');
    return this.db.repos.tasks.list(actor.orgId, filter);
  }

  async require(actor: Actor, id: string): Promise<Task> {
    assertCan(actor, 'tasks:read');
    return this.db.repos.tasks.require(actor.orgId, id);
  }

  async update(
    actor: Actor,
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      priority?: Priority;
      assigneeId?: string | null;
      dueDate?: string | null;
      estimatedHours?: number | null;
      expectedVersion?: number;
    },
  ): Promise<Task> {
    assertCan(actor, 'tasks:write');

    const before = await this.db.repos.tasks.require(actor.orgId, id);

    if (patch.assigneeId) {
      const membership = await this.db.repos.memberships.findByUser(actor.orgId, patch.assigneeId);
      if (!membership) throw new ValidationError('The assignee must be a member of this organization.', { assigneeId: patch.assigneeId });
    }

    const updated = await this.db.repos.tasks.update(actor.orgId, id, patch, patch.expectedVersion);
    await this.audit.record(actor, 'task.updated', 'task', id, {
      changed: Object.keys(patch).filter((k) => k !== 'expectedVersion'),
      from: pick(before, Object.keys(patch)),
      to: pick(updated, Object.keys(patch)),
    });
    return updated;
  }

  /**
   * Requests a status transition. This is the only path to `tasks.status`.
   *
   * Permission and legality are checked separately and in that order, so the caller gets a
   * specific error: an unauthorized member gets 403, a legal-but-illegal-here move gets 409 with
   * the transitions that *would* be allowed.
   */
  async transition(actor: Actor, id: string, to: TaskStatus, note?: string): Promise<Task> {
    const current = await this.db.repos.tasks.require(actor.orgId, id);

    assertCan(actor, 'tasks:transition', { assigneeId: current.assigneeId });

    if (!canTransition(current.status, to)) {
      throw new InvalidTransitionError(current.status, to, allowedTransitions(current.status).map((t) => t.to));
    }

    const rule = findTransition(current.status, to);
    if (to === 'in_progress') await this.operations.assertCanStart(actor, id);
    if (to === 'in_review') await this.operations.assertCanSubmitForReview(actor, id);
    if (to === 'completed') await this.operations.assertCanComplete(actor, id);
    const updated = await this.db.repos.tasks.setStatus(actor.orgId, id, to);

    await this.audit.record(actor, `task.${rule?.action ?? 'transitioned'}`, 'task', id, {
      from: current.status,
      to,
      effect: rule?.effect ?? null,
      note: note ?? null,
    });

    return updated;
  }

  /**
   * Moves a draft to `pending_approval` — "please look at this", not "I approved this".
   *
   * This has its own narrow capability (`tasks:submit`) instead of reusing `tasks:transition`,
   * because it is the one status change an agent is allowed to make. It cannot approve, cannot
   * reject, and cannot move work that is already in flight.
   */
  async submitForApproval(actor: Actor, id: string, note?: string): Promise<{ task: Task; requiresHumanConfirmation: true }> {
    assertCan(actor, 'tasks:submit');

    const current = await this.db.repos.tasks.require(actor.orgId, id);
    if (!canTransition(current.status, 'pending_approval')) {
      throw new InvalidTransitionError(
        current.status,
        'pending_approval',
        allowedTransitions(current.status).map((t) => t.to),
      );
    }

    const updated = await this.db.repos.tasks.setStatus(actor.orgId, id, 'pending_approval');
    await this.audit.record(actor, 'task.submit_for_approval', 'task', id, {
      from: current.status,
      to: 'pending_approval',
      note: note ?? null,
      requiresHumanConfirmation: true,
    });

    return { task: updated, requiresHumanConfirmation: true };
  }

  /** The transitions this actor may perform on this task — what the UI is allowed to render. */
  async availableActions(actor: Actor, task: Task): Promise<Array<{ to: TaskStatus; effect: string; action: string }>> {
    return allowedTransitions(task.status)
      .filter(() => {
        try {
          assertCan(actor, 'tasks:transition', { assigneeId: task.assigneeId });
          return true;
        } catch {
          return false;
        }
      })
      .map((rule) => ({ to: rule.to, effect: rule.effect, action: rule.action }));
  }

  async blockedActions(actor: Actor, task: Task): Promise<Array<{ to: TaskStatus; reason: string }>> {
    const actions = await this.availableActions(actor, task);
    const detail = await this.operations.detail(actor, task.id);
    const blocked: Array<{ to: TaskStatus; reason: string }> = [];
    if (actions.some((action) => action.to === 'in_progress') && detail.blockedBy.length) {
      blocked.push({ to: 'in_progress', reason: `Waiting on ${detail.blockedBy.map((item) => item.dependsOnTitle).join(', ')}.` });
    }
    const incomplete = detail.checklist.filter((item) => !item.isComplete);
    if (actions.some((action) => action.to === 'in_review') && incomplete.length) {
      blocked.push({ to: 'in_review', reason: `${incomplete.length} checklist item(s) still need completion.` });
    }
    if (actions.some((action) => action.to === 'completed') && detail.clientReview && detail.clientReview.status !== 'approved') {
      blocked.push({ to: 'completed', reason: `Client review is ${detail.clientReview.status.replace('_', ' ')}.` });
    }
    return blocked;
  }
}

function pick<T extends object>(source: T, keys: string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (key in source) out[key as keyof T] = source[key as keyof T];
  }
  return out;
}
