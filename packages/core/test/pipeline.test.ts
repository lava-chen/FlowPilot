import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, InvalidTransitionError, ValidationError } from '@flowpilot/shared';
import { MockEmailAdapter } from '@flowpilot/integrations';
import { ingestAndDraft } from '@flowpilot/integrations';
import { ADMIN_EMAIL, createTestContext, MANAGER_EMAIL, MEMBER_EMAIL, type TestContext } from './harness.js';

/**
 * The v0.1 acceptance scenario, end to end, against a real database:
 * email -> request -> analysis -> draft -> approval -> assignment -> completion.
 */
describe('request → analysis → draft → approval → assignment → completion', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('runs the whole pipeline from a simulated client email', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const adapter = new MockEmailAdapter();

    const { request, draft } = await ingestAndDraft(
      ctx.core,
      manager,
      adapter,
      MockEmailAdapter.message('harbor-logo', 1),
      { createDraft: true },
    );

    // 2. a request exists and remembers where it came from
    expect(request.status).toBe('drafted');
    expect(request.externalId).toContain('harbor-logo');
    expect(request.rawBody).toContain('Alice');

    // 3. the analysis grounded the request in real records
    expect(request.analysis).not.toBeNull();
    expect(request.analysis?.provider).toBe('deterministic');
    expect(request.analysis?.clientId).toBe('cli_harbor');
    expect(request.analysis?.priority).toBe('high');
    expect(request.projectId).toBe('prj_hbc_fall');

    // 4. a draft exists, still not approved
    expect(draft).not.toBeNull();
    expect(draft?.status).toBe('draft');
    expect(draft?.source).toBe('human');
    expect(draft?.requestId).toBe(request.id);

    // 5. a manager approves it → ready + assigned
    const approved = await ctx.core.approvals.decide(manager, {
      taskId: draft!.id,
      decision: 'approved',
      note: 'Logo fix is in the paid flight window — approved.',
    });
    expect(approved.task.status).toBe('ready');
    expect(approved.task.assigneeId).not.toBeNull();

    // 6. the employee works it to completion
    const member = await ctx.actorFor(MEMBER_EMAIL);
    const assigned = await ctx.db.repos.tasks.require(ctx.orgId, draft!.id);
    if (assigned.assigneeId !== member.userId) {
      await ctx.core.tasks.update(manager, draft!.id, { assigneeId: member.userId });
    }

    await ctx.core.tasks.transition(member, draft!.id, 'in_progress');
    await ctx.core.tasks.transition(member, draft!.id, 'in_review');
    const done = await ctx.core.tasks.transition(member, draft!.id, 'completed');
    expect(done.status).toBe('completed');

    // 7. every hop is in the audit trail, in order
    const trail = await ctx.core.audit.list(ctx.orgId, { limit: 100, entityType: 'task', entityId: draft!.id });
    const actions = trail.map((e) => e.action);
    expect(actions).toContain('task.draft_created');
    expect(actions).toContain('approval.decided');
    expect(actions).toContain('task.start');
    expect(actions).toContain('task.submit');
    expect(actions).toContain('task.complete');

    const completed = trail.find((e) => e.action === 'task.complete');
    expect(completed?.metadata).toMatchObject({ from: 'in_review', to: 'completed' });
  });

  it('records the run steps so the Activity page can show the history', async () => {
    const runs = await ctx.core.queries.activity(await ctx.actorFor(ADMIN_EMAIL), 50);
    const run = runs.runs.find((r) => r.trigger === 'mock_email');
    expect(run).toBeDefined();
    expect(run?.steps.map((s) => s.key)).toContain('ingest');
  });

  it('closes the approval step on the run when a human decides', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const adapter = new MockEmailAdapter();
    const { draft } = await ingestAndDraft(
      ctx.core,
      manager,
      adapter,
      MockEmailAdapter.message('cedar-captions', 2),
      { createDraft: true },
    );

    const runsBefore = await ctx.db.repos.workflowRuns.list(ctx.orgId, { limit: 50 });
    const runBefore = runsBefore.find((r) => r.taskId === draft?.id);
    expect(runBefore?.status).toBe('waiting_approval');
    expect(runBefore?.steps.find((s) => s.key === 'approval')?.status).toBe('pending');

    await ctx.core.approvals.decide(manager, { taskId: draft!.id, decision: 'approved' });

    const runsAfter = await ctx.db.repos.workflowRuns.list(ctx.orgId, { limit: 50 });
    const runAfter = runsAfter.find((r) => r.taskId === draft?.id);
    expect(runAfter?.status).toBe('succeeded');
    expect(runAfter?.steps.find((s) => s.key === 'approval')?.status).toBe('succeeded');
  });
});

describe('idempotency and duplicate protection', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('returns the original request instead of creating a second one', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const adapter = new MockEmailAdapter();
    const message = MockEmailAdapter.message('lumen-cutdown', 1);

    const first = await ctx.core.requests.ingest(manager, message);
    expect(first.deduplicated).toBe(false);

    const second = await ctx.core.requests.ingest(manager, message);
    expect(second.deduplicated).toBe(true);
    expect(second.request.id).toBe(first.request.id);

    const rows = await ctx.db.repos.requests.list(ctx.orgId, { limit: 200 });
    expect(rows.filter((r) => r.externalId === message.externalId)).toHaveLength(1);
  });

  it('does not create a second draft for the same request', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const adapter = new MockEmailAdapter();

    // A freshly ingested request, so this test does not depend on whether the seed already gave
    // a particular request a draft.
    const ingested = await ctx.core.requests.ingest(manager, MockEmailAdapter.message('cedar-captions', 21));
    await ctx.core.requests.analyze(manager, ctx.core.ai, { requestId: ingested.request.id });

    await ctx.core.tasks.createDraftFromRequest(manager, ingested.request.id);

    await expect(ctx.core.tasks.createDraftFromRequest(manager, ingested.request.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await ctx.db.repos.tasks.findByRequest(ctx.orgId, ingested.request.id)).toHaveLength(1);
  });

  it('rejects a malformed inbound message before it reaches the database', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    await expect(
      ctx.core.requests.ingest(manager, {
        provider: 'mock-email',
        externalId: 'bad-1',
        from: 'not-an-email',
        subject: 'x',
        body: 'y',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('rules the core layer refuses to break', () => {
  let ctx: TestContext;
  let draftId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const adapter = new MockEmailAdapter();
    const { draft } = await ingestAndDraft(
      ctx.core,
      manager,
      adapter,
      MockEmailAdapter.message('lumen-music-license', 1),
      { createDraft: true },
    );
    draftId = draft!.id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('refuses an illegal status transition and lists the legal ones', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    await expect(ctx.core.tasks.transition(manager, draftId, 'completed')).rejects.toBeInstanceOf(InvalidTransitionError);

    try {
      await ctx.core.tasks.transition(manager, draftId, 'completed');
    } catch (error) {
      const err = error as InvalidTransitionError;
      expect(err.from).toBe('draft');
      expect(err.to).toBe('completed');
      expect(err.details['allowed']).toEqual(expect.arrayContaining(['pending_approval', 'cancelled']));
    }
  });

  it('refuses to approve a task that is not awaiting approval', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    // 'ready' work is already released — approving it again is a no-op at best and a state lie
    // at worst, so the gate must refuse it.
    await expect(
      ctx.core.approvals.decide(manager, { taskId: 'tsk_cedar_916', decision: 'approved' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to approve work with no assignee', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    await ctx.core.tasks.update(manager, draftId, { assigneeId: null });
    await expect(ctx.core.approvals.decide(manager, { taskId: draftId, decision: 'approved' })).rejects.toThrow(
      /Assign an owner/,
    );
  });

  it('refuses a member who is not the assignee from moving the task', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    const member = await ctx.actorFor(MEMBER_EMAIL);
    await ctx.core.tasks.update(manager, draftId, { assigneeId: 'usr_jordan' });

    await expect(ctx.core.tasks.transition(member, draftId, 'pending_approval')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses to create a draft without the capability', async () => {
    const member = await ctx.actorFor(MEMBER_EMAIL);
    await expect(
      ctx.core.tasks.createDraft(member, { projectId: 'prj_hbc_fall', title: 'Member should not create drafts' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses an assignee outside the organization', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);
    await expect(
      ctx.core.tasks.createDraft(manager, {
        projectId: 'prj_hbc_fall',
        title: 'Assign to a stranger',
        assigneeId: 'usr_does_not_exist',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('only renders transitions the actor is actually allowed to perform', async () => {
    const manager = await ctx.actorFor(ADMIN_EMAIL);

    // Its own draft: sibling tests in this block mutate `draftId`, and a test that depends on
    // another test's leftover state is a test that will fail for the wrong reason one day.
    const fresh = await ingestAndDraft(
      ctx.core,
      manager,
      new MockEmailAdapter(),
      MockEmailAdapter.message('lumen-music-license', 42),
      { createDraft: true },
    );
    const task = await ctx.core.tasks.require(manager, fresh.draft!.id);

    const managerActions = await ctx.core.tasks.availableActions(manager, task);
    expect(managerActions.map((a) => a.to)).toEqual(expect.arrayContaining(['pending_approval', 'cancelled']));

    // A member who is not the assignee gets no actions at all.
    const other = await ctx.actorFor(MEMBER_EMAIL);
    expect(await ctx.core.tasks.availableActions(other, task)).toEqual([]);

    // The assignee does get actions — their own board is theirs to move.
    await ctx.core.tasks.update(manager, fresh.draft!.id, { assigneeId: 'usr_theo' });
    const reassigned = await ctx.core.tasks.require(manager, fresh.draft!.id);
    const assigneeActions = await ctx.core.tasks.availableActions(other, reassigned);
    expect(assigneeActions.map((a) => a.to)).toEqual(expect.arrayContaining(['pending_approval']));
  });

  it('rejects a manager-level decision from a member', async () => {
    const member = await ctx.actorFor(MEMBER_EMAIL);
    await expect(
      ctx.core.approvals.decide(member, { taskId: draftId, decision: 'approved' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('deterministic AI analysis', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('extracts client, project, priority and discipline from the message body', async () => {
    const manager = await ctx.actorFor(MANAGER_EMAIL);
    const adapter = new MockEmailAdapter();
    const { request } = await ingestAndDraft(
      ctx.core,
      manager,
      adapter,
      MockEmailAdapter.message('harbor-store-retouch', 7),
      { createDraft: true },
    );

    const analysis = request.analysis!;
    expect(analysis.clientName).toContain('Harbor');
    expect(analysis.projectId).toBe('prj_hbc_retouch');
    expect(analysis.priority).toBe('urgent');
    expect(analysis.discipline).toBe('design');
    expect(analysis.evidence.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same message produces the same analysis twice', async () => {
    const manager = await ctx.actorFor(MANAGER_EMAIL);
    const adapter = new MockEmailAdapter();
    const message = MockEmailAdapter.message('lumen-cutdown', 9);

    const first = await ctx.core.requests.ingest(manager, message);
    await ctx.core.requests.analyze(manager, ctx.core.ai, { requestId: first.request.id });
    const a = (await ctx.db.repos.requests.require(ctx.orgId, first.request.id)).analysis;

    const message2 = { ...message, externalId: `${message.externalId}-b` };
    const second = await ctx.core.requests.ingest(manager, message2);
    await ctx.core.requests.analyze(manager, ctx.core.ai, { requestId: second.request.id });
    const b = (await ctx.db.repos.requests.require(ctx.orgId, second.request.id)).analysis;

    expect({ ...a, createdAt: '' }).toEqual({ ...b, createdAt: '' });
  });

  it('flags low-confidence extractions for human review', async () => {
    const manager = await ctx.actorFor(MANAGER_EMAIL);
    const { analyzed } = await ctx.core.requests.analyze(manager, ctx.core.ai);
    expect(analyzed.length).toBeGreaterThan(0);
    for (const request of analyzed) {
      expect(request.analysis).not.toBeNull();
      expect(request.analysis?.needsHumanReview).toBeTypeOf('boolean');
    }
  });

  it('refuses to create a draft from a request that was never analyzed', async () => {
    const manager = await ctx.actorFor(MANAGER_EMAIL);
    // Created here rather than relying on a leftover fixture: an earlier test in this describe
    // sweeps the whole pending inbox, so a "new" request cannot be assumed to exist.
    const fresh = await ctx.core.requests.ingest(manager, MockEmailAdapter.message('lumen-music-license', 99));
    expect(fresh.request.status).toBe('new');
    await expect(ctx.core.tasks.createDraftFromRequest(manager, fresh.request.id)).rejects.toBeInstanceOf(ValidationError);
  });
});
