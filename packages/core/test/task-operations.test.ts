import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError } from '@flowpilot/shared';
import { createForeignOrg, createTestContext, type TestContext, MEMBER_EMAIL, ADMIN_EMAIL } from './harness.js';

describe('task coordination and client sign-off', () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await createTestContext(); });
  afterAll(async () => { await ctx.close(); });

  async function createApprovedTask(title: string, assigneeId = 'usr_theo', estimatedHours?: number) {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const task = await ctx.core.tasks.createDraft(manager, {
      projectId: 'prj_cedar_teaser', title, priority: 'normal', assigneeId,
      dueDate: currentWeekStart(), estimatedHours: estimatedHours ?? null, source: 'human',
    });
    await ctx.core.approvals.decide(manager, { taskId: task.id, decision: 'approved' });
    return task.id;
  }

  it('prevents starting blocked work and rejects dependency cycles', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const member = await ctx.actorFor(MEMBER_EMAIL);
    const prerequisite = await createApprovedTask('Finish source footage selects');
    const dependent = await createApprovedTask('Cut campaign hero from selects');

    await ctx.core.taskOperations.addDependency(manager, dependent, prerequisite);
    await expect(ctx.core.tasks.transition(member, dependent, 'in_progress')).rejects.toBeInstanceOf(ConflictError);
    await expect(ctx.core.taskOperations.addDependency(manager, prerequisite, dependent)).rejects.toBeInstanceOf(ConflictError);

    await ctx.core.tasks.transition(member, prerequisite, 'in_progress');
    await ctx.core.tasks.transition(member, prerequisite, 'in_review');
    await ctx.core.tasks.transition(member, prerequisite, 'completed');
    await expect(ctx.core.tasks.transition(member, dependent, 'in_progress')).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('stores checklist, comments, delivery links and time, then records client changes and approval separately', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const member = await ctx.actorFor(MEMBER_EMAIL);
    const taskId = await createApprovedTask('Review launch edit with client');

    const checklist = await ctx.core.taskOperations.addChecklistItem(member, taskId, 'Check legal end card');
    const comment = await ctx.core.taskOperations.addComment(member, taskId, 'The latest cut uses the approved music bed.');
    const link = await ctx.core.taskOperations.addLink(member, taskId, {
      label: 'Final review cut', url: 'https://example.com/final-review-cut', kind: 'delivery',
    });
    await ctx.core.taskOperations.logTime(member, taskId, { hours: 1.25, description: 'Edit and export QA' });

    await ctx.core.tasks.transition(member, taskId, 'in_progress');
    await expect(ctx.core.tasks.transition(member, taskId, 'in_review')).rejects.toBeInstanceOf(ConflictError);
    await ctx.core.taskOperations.updateChecklistItem(member, taskId, checklist.id, { isComplete: true });
    await ctx.core.tasks.transition(member, taskId, 'in_review');

    const firstReview = await ctx.core.taskOperations.requestClientReview(manager, taskId, 'https://flowpilot.example');
    const firstToken = firstReview.url.split('/').at(-1)!;
    const portal = await ctx.core.taskOperations.clientReviewPortal(firstToken);
    expect(portal).toMatchObject({ taskTitle: 'Review launch edit with client', clientName: 'Cedar & Sage Skincare' });
    expect(portal.links).toEqual([expect.objectContaining({ id: link.id, label: 'Final review cut', kind: 'delivery' })]);
    expect(JSON.stringify(portal)).not.toContain(firstToken);

    await ctx.core.taskOperations.respondToClientReview(firstToken, {
      decision: 'changes_requested', reviewerName: 'Rosa Iversen', reviewerEmail: 'rosa@example.com', note: 'Please keep the end card on screen one second longer.',
    });
    await expect(ctx.core.tasks.transition(member, taskId, 'completed')).rejects.toBeInstanceOf(ConflictError);
    await expect(ctx.core.taskOperations.respondToClientReview(firstToken, {
      decision: 'approved', reviewerName: 'Rosa Iversen',
    })).rejects.toThrow();

    await ctx.core.tasks.transition(member, taskId, 'in_progress');
    await ctx.core.taskOperations.updateChecklistItem(member, taskId, checklist.id, { title: 'Check legal end card and duration' });
    await ctx.core.tasks.transition(member, taskId, 'in_review');
    const secondReview = await ctx.core.taskOperations.requestClientReview(manager, taskId, 'https://flowpilot.example');
    const secondToken = secondReview.url.split('/').at(-1)!;
    await ctx.core.taskOperations.respondToClientReview(secondToken, { decision: 'approved', reviewerName: 'Rosa Iversen' });
    await expect(ctx.core.tasks.transition(member, taskId, 'completed')).resolves.toMatchObject({ status: 'completed' });

    const detail = await ctx.core.taskOperations.detail(manager, taskId);
    expect(detail).toMatchObject({ loggedHours: 1.25, clientReview: { status: 'approved' } });
    expect(detail.comments).toContainEqual(expect.objectContaining({ id: comment.id }));
    const audit = await ctx.core.audit.list(ctx.orgId, { limit: 50, entityType: 'task', entityId: taskId });
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining([
      'task.comment_added', 'task.link_added', 'task.time_logged', 'task.client_review_changes_requested', 'task.client_review_approved',
    ]));
  });

  it('keeps tasks and task-operation records isolated by organization and assignee permissions', async () => {
    const member = await ctx.actorFor(MEMBER_EMAIL);
    const foreign = await createForeignOrg(ctx.db, 'Operations isolation test');
    await expect(ctx.core.taskOperations.addComment(member, foreign.taskId, 'Should not leak')).rejects.toBeTruthy();

    const unassigned = await ctx.core.tasks.createDraft(await ctx.actorFor(ADMIN_EMAIL), {
      projectId: 'prj_cedar_teaser', title: 'Not assigned to Theo', priority: 'normal', source: 'human',
    });
    await expect(ctx.core.taskOperations.addComment(member, unassigned.id, 'No access')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('uses due-week task estimates against each member weekly capacity', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const taskId = await createApprovedTask('Owen capacity probe', 'usr_owen', 6);
    const data = await ctx.core.queries.overview(manager);
    const owen = data.workload.find((member) => member.userId === 'usr_owen');
    expect(owen).toMatchObject({ weeklyCapacityHours: 16, plannedHours: 6, utilizationPercent: 38 });
    expect((await ctx.core.tasks.require(manager, taskId)).estimatedHours).toBe(6);
  });
});

function currentWeekStart(): string {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}
