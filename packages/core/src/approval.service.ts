import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor, Approval, Task } from '@flowpilot/domain';
import { actorLabel } from '@flowpilot/domain';
import { newId, nowIso, ValidationError } from '@flowpilot/shared';
import type { AuditService } from './audit.service.js';
import type { WorkflowFactory } from './services.js';
import { assertCan } from './permissions.js';

/**
 * Human approval gate.
 *
 * Deliberately unreachable from an agent: `assertCan(actor, 'approvals:decide')` has no agent
 * scope mapped to it, so an MCP tool wired to this service by mistake still fails closed.
 * Releasing work to a crew is a person's decision — that is the product.
 */
export class ApprovalService {
  constructor(
    private readonly db: FlowPilotDb,
    private readonly audit: AuditService,
    private readonly workflowsFor: WorkflowFactory,
  ) {}

  async decide(
    actor: Actor,
    input: { taskId: string; decision: 'approved' | 'rejected'; note?: string },
  ): Promise<{ task: Task; approval: Approval }> {
    assertCan(actor, 'approvals:decide');

    const task = await this.db.repos.tasks.require(actor.orgId, input.taskId);

    // A PM's "Approve" is one action. When the task is still a draft we record the
    // draft -> pending_approval hop first, so the audit trail still shows the full sequence and
    // the state machine is still the only thing that decides what is legal.
    let statusForGate: Task['status'] = task.status;
    if (task.status === 'draft') {
      await this.db.repos.tasks.setStatus(actor.orgId, task.id, 'pending_approval');
      statusForGate = 'pending_approval';
    }

    if (statusForGate !== 'pending_approval') {
      throw new ValidationError(`Only tasks awaiting approval can be decided. This task is "${task.status}".`, {
        taskId: task.id,
        status: task.status,
      });
    }
    if (input.decision === 'approved' && !task.assigneeId) {
      throw new ValidationError('Assign an owner before approving — approved work needs someone to do it.', {
        taskId: task.id,
      });
    }

    // The approval row and the status change commit together: a half-approved task is exactly the
    // state that erodes trust in an audit trail.
    const { task: updated, approval } = await this.db.withTransaction(async (tx) => {
      const approval = await tx.repos.approvals.create({
        id: newId('approval'),
        orgId: actor.orgId,
        taskId: task.id,
        requestId: task.requestId,
        decision: input.decision,
        note: input.note ?? null,
        decidedBy: actor.kind === 'user' ? actor.userId : actor.orgId,
        decidedByLabel: actorLabel(actor),
      });
      const changed = await tx.repos.tasks.setStatus(
        actor.orgId,
        task.id,
        input.decision === 'approved' ? 'ready' : 'rejected',
      );
      if (task.requestId) {
        await tx.repos.requests.setStatus(actor.orgId, task.requestId, input.decision === 'approved' ? 'approved' : 'rejected');
      }
      return { task: changed, approval };
    });

    await this.closeRunStep(actor.orgId, task.id, input.decision, actorLabel(actor));

    await this.audit.record(actor, 'approval.decided', 'task', task.id, {
      decision: input.decision,
      note: input.note ?? null,
      assigneeId: updated.assigneeId,
      from: task.status,
      to: updated.status,
    });

    return { task: updated, approval };
  }

  async history(actor: Actor, taskId: string): Promise<Approval[]> {
    assertCan(actor, 'tasks:read');
    return this.db.repos.approvals.listByTask(actor.orgId, taskId);
  }

  async recent(actor: Actor, limit: number): Promise<Approval[]> {
    assertCan(actor, 'tasks:read');
    return this.db.repos.approvals.listByOrg(actor.orgId, limit);
  }

  /** Finds the run that produced this task and resolves its pending approval step. */
  private async closeRunStep(
    orgId: string,
    taskId: string,
    decision: 'approved' | 'rejected',
    decidedByLabel: string,
  ): Promise<void> {
    // `list` is newest-first, so the first match is the run that created this draft.
    const runs = await this.db.repos.workflowRuns.list(orgId, { limit: 25 });
    const run = runs.find((candidate) => candidate.taskId === taskId);
    if (!run) return;

    await this.workflowsFor({ kind: 'system', orgId, label: 'workflow' }).step(
      run,
      {
        key: 'approval',
        label: 'Human approval',
        status: 'succeeded',
        startedAt: nowIso(),
        detail: { decision, decidedBy: decidedByLabel },
      },
      'succeeded',
    );
  }
}
