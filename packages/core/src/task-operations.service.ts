import { createHash, randomBytes } from 'node:crypto';
import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor } from '@flowpilot/domain';
import { actorId, actorLabel } from '@flowpilot/domain';
import { ConflictError, newId, NotFoundError, ValidationError } from '@flowpilot/shared';
import type { AuditService } from './audit.service.js';
import { assertCan } from './permissions.js';

type ReviewDecision = { decision: 'approved' | 'changes_requested'; reviewerName: string; reviewerEmail?: string; note?: string };

export class TaskOperationsService {
  constructor(private readonly db: FlowPilotDb, private readonly audit: AuditService) {}

  async detail(actor: Actor, taskId: string) {
    assertCan(actor, 'tasks:read');
    await this.db.repos.tasks.require(actor.orgId, taskId);
    const [checklist, comments, links, timeEntries, dependencies, clientReview] = await Promise.all([
      this.db.repos.taskOperations.listChecklist(actor.orgId, taskId),
      this.db.repos.taskOperations.listComments(actor.orgId, taskId),
      this.db.repos.taskOperations.listLinks(actor.orgId, taskId),
      this.db.repos.taskOperations.listTimeEntries(actor.orgId, taskId),
      this.db.repos.taskOperations.listDependencies(actor.orgId, taskId),
      this.db.repos.taskOperations.getLatestReview(actor.orgId, taskId),
    ]);
    const loggedHours = Number(timeEntries.reduce((sum, entry) => sum + entry.hours, 0).toFixed(2));
    const blockedBy = dependencies.filter((dependency) => dependency.dependsOnStatus !== 'completed');
    const currentClientReview = clientReview?.status === 'pending' && new Date(clientReview.expiresAt).getTime() <= Date.now()
      ? { ...clientReview, status: 'expired' as const }
      : clientReview;
    return { checklist, comments, links, timeEntries, dependencies, blockedBy, loggedHours, clientReview: currentClientReview };
  }

  async addChecklistItem(actor: Actor, taskId: string, title: string) {
    await this.requireContribution(actor, taskId);
    const item = await this.db.repos.taskOperations.createChecklist({
      id: newId('checklist'), orgId: actor.orgId, taskId, title: title.trim(), createdBy: actorId(actor),
    });
    await this.audit.record(actor, 'task.checklist_item_added', 'task', taskId, { itemId: item.id, title: item.title });
    return item;
  }

  async updateChecklistItem(actor: Actor, taskId: string, itemId: string, patch: { title?: string; isComplete?: boolean }) {
    await this.requireContribution(actor, taskId);
    const item = await this.db.repos.taskOperations.updateChecklist(actor.orgId, taskId, itemId, patch);
    if (!item) throw new NotFoundError('Checklist item', itemId);
    await this.audit.record(actor, item.isComplete ? 'task.checklist_item_completed' : 'task.checklist_item_updated', 'task', taskId,
      { itemId: item.id, title: item.title, isComplete: item.isComplete });
    return item;
  }

  async addComment(actor: Actor, taskId: string, body: string) {
    await this.requireContribution(actor, taskId);
    const comment = await this.db.repos.taskOperations.addComment({
      id: newId('comment'), orgId: actor.orgId, taskId, authorId: actorId(actor), authorLabel: actorLabel(actor), body: body.trim(),
    });
    await this.audit.record(actor, 'task.comment_added', 'task', taskId, { commentId: comment.id });
    return comment;
  }

  async addLink(actor: Actor, taskId: string, input: { label: string; url: string; kind: 'brief' | 'reference' | 'delivery' | 'other' }) {
    await this.requireContribution(actor, taskId);
    let url: URL;
    try { url = new URL(input.url); } catch { throw new ValidationError('Enter a valid HTTP or HTTPS link.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new ValidationError('Links must use HTTP or HTTPS.');
    const link = await this.db.repos.taskOperations.addLink({
      id: newId('taskLink'), orgId: actor.orgId, taskId, label: input.label.trim(), url: url.toString(), kind: input.kind, addedBy: actorId(actor),
    });
    await this.audit.record(actor, 'task.link_added', 'task', taskId, { linkId: link.id, kind: link.kind, label: link.label });
    return link;
  }

  async logTime(actor: Actor, taskId: string, input: { hours: number; description?: string; loggedOn?: string }) {
    await this.requireContribution(actor, taskId);
    if (actor.kind !== 'user') throw new ValidationError('Time entries must be recorded by a signed-in team member.');
    const entry = await this.db.repos.taskOperations.addTimeEntry({
      id: newId('timeEntry'), orgId: actor.orgId, taskId, userId: actor.userId,
      hours: input.hours, description: input.description?.trim(), loggedOn: input.loggedOn,
    });
    await this.audit.record(actor, 'task.time_logged', 'task', taskId, { entryId: entry.id, hours: entry.hours, loggedOn: entry.loggedOn });
    return entry;
  }

  async addDependency(actor: Actor, taskId: string, dependsOnTaskId: string) {
    assertCan(actor, 'tasks:write');
    if (taskId === dependsOnTaskId) throw new ValidationError('A task cannot depend on itself.');
    const task = await this.db.repos.tasks.require(actor.orgId, taskId);
    const predecessor = await this.db.repos.tasks.require(actor.orgId, dependsOnTaskId);
    if (task.status === 'completed' || task.status === 'cancelled') throw new ValidationError('Dependencies cannot be changed on a closed task.');
    const edges = await this.db.repos.taskOperations.listAllDependencies(actor.orgId);
    if (hasPath(edges, dependsOnTaskId, taskId)) {
      throw new ConflictError('This dependency would create a cycle. Remove another dependency first.', { taskId, dependsOnTaskId });
    }
    if (edges.some((edge) => edge.taskId === taskId && edge.dependsOnTaskId === dependsOnTaskId)) {
      throw new ConflictError('That dependency is already on this task.', { taskId, dependsOnTaskId });
    }
    await this.db.repos.taskOperations.addDependency({ id: newId('dependency'), orgId: actor.orgId, taskId, dependsOnTaskId });
    await this.audit.record(actor, 'task.dependency_added', 'task', taskId, { dependsOnTaskId, dependsOnTitle: predecessor.title });
    return this.db.repos.taskOperations.listDependencies(actor.orgId, taskId);
  }

  async removeDependency(actor: Actor, taskId: string, dependsOnTaskId: string) {
    assertCan(actor, 'tasks:write');
    await this.db.repos.tasks.require(actor.orgId, taskId);
    await this.db.repos.tasks.require(actor.orgId, dependsOnTaskId);
    const removed = await this.db.repos.taskOperations.removeDependency(actor.orgId, taskId, dependsOnTaskId);
    if (!removed) throw new NotFoundError('Task dependency', dependsOnTaskId);
    await this.audit.record(actor, 'task.dependency_removed', 'task', taskId, { dependsOnTaskId });
  }

  async assertCanStart(actor: Actor, taskId: string): Promise<void> {
    assertCan(actor, 'tasks:read');
    const blockedBy = (await this.db.repos.taskOperations.listDependencies(actor.orgId, taskId))
      .filter((dependency) => dependency.dependsOnStatus !== 'completed');
    if (blockedBy.length) {
      throw new ConflictError('This task is blocked until its prerequisite tasks are complete.', {
        blockedBy: blockedBy.map((dependency) => ({ taskId: dependency.dependsOnTaskId, title: dependency.dependsOnTitle, status: dependency.dependsOnStatus })),
      });
    }
  }

  async assertCanSubmitForReview(actor: Actor, taskId: string): Promise<void> {
    assertCan(actor, 'tasks:read');
    const incomplete = (await this.db.repos.taskOperations.listChecklist(actor.orgId, taskId)).filter((item) => !item.isComplete);
    if (incomplete.length) {
      throw new ConflictError('Complete the task checklist before submitting for review.', {
        incompleteItems: incomplete.map((item) => ({ id: item.id, title: item.title })),
      });
    }
  }

  async assertCanComplete(actor: Actor, taskId: string): Promise<void> {
    assertCan(actor, 'tasks:read');
    const review = await this.db.repos.taskOperations.getLatestReview(actor.orgId, taskId);
    if (review && review.status !== 'approved') {
      throw new ConflictError('The latest client review must be approved before this task can be completed.', {
        clientReviewStatus: review.status, expiresAt: review.expiresAt,
      });
    }
  }

  async requestClientReview(actor: Actor, taskId: string, appOrigin: string) {
    assertCan(actor, 'tasks:write');
    const task = await this.db.repos.tasks.require(actor.orgId, taskId);
    if (task.status !== 'in_review') throw new ValidationError('Move the task to In Review before requesting client sign-off.');
    const links = await this.db.repos.taskOperations.listLinks(actor.orgId, taskId);
    if (!links.some((link) => link.kind === 'delivery')) throw new ValidationError('Add a delivery link before requesting client sign-off.');
    const previous = await this.db.repos.taskOperations.getLatestReview(actor.orgId, taskId);
    if (previous?.status === 'pending' && new Date(previous.expiresAt).getTime() > Date.now()) {
      throw new ConflictError('A client review link is already active for this task.', { expiresAt: previous.expiresAt });
    }
    if (previous?.status === 'pending') await this.db.repos.taskOperations.expireReview(actor.orgId, previous.id);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    let review;
    try {
      review = await this.db.repos.taskOperations.createReview({
        id: newId('taskReview'), orgId: actor.orgId, taskId, tokenHash, requestedBy: actorId(actor), expiresAt,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('A client review link was just created for this task. Reload and use that link.');
      throw error;
    }
    await this.audit.record(actor, 'task.client_review_requested', 'task', taskId, { reviewId: review.id, expiresAt });
    return { review, url: `${appOrigin.replace(/\/$/, '')}/review/${token}` };
  }

  async clientReviewPortal(token: string) {
    const row = await this.db.repos.taskOperations.findReviewPortal(hashToken(token));
    if (!row) throw new NotFoundError('Client review');
    const links = await this.db.repos.taskOperations.listLinks(String(row['org_id']), String(row['task_id']));
    return {
      taskTitle: String(row['task_title']),
      projectName: String(row['project_name']),
      clientName: String(row['client_name']),
      expiresAt: String(row['expires_at']),
      links: links.filter((link) => link.kind === 'delivery')
        .map(({ id, label, url, kind, createdAt }) => ({ id, label, url, kind, createdAt })),
    };
  }

  async respondToClientReview(token: string, input: ReviewDecision) {
    const review = await this.db.repos.taskOperations.respondReview(hashToken(token), {
      status: input.decision === 'approved' ? 'approved' : 'changes_requested',
      reviewerName: input.reviewerName.trim(), reviewerEmail: input.reviewerEmail?.trim(), note: input.note?.trim(),
    });
    if (!review) throw new NotFoundError('Client review');
    const actor: Actor = { kind: 'system', orgId: review.orgId, label: `Client reviewer: ${review.reviewerName}` };
    await this.audit.record(actor, `task.client_review_${review.status}`, 'task', review.taskId, {
      reviewId: review.id, reviewerName: review.reviewerName, reviewerEmail: review.reviewerEmail, note: review.note,
    });
    return review;
  }

  private async requireContribution(actor: Actor, taskId: string) {
    const task = await this.db.repos.tasks.require(actor.orgId, taskId);
    assertCan(actor, 'tasks:contribute', { assigneeId: task.assigneeId });
    return task;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

function hasPath(edges: Array<{ taskId: string; dependsOnTaskId: string }>, from: string, target: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.taskId, [...(outgoing.get(edge.taskId) ?? []), edge.dependsOnTaskId]);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(outgoing.get(current) ?? []));
  }
  return false;
}
