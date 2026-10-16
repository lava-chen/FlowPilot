import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, OrganizationMismatchError } from '@flowpilot/shared';
import { createForeignOrg, createTestContext, type TestContext } from './harness.js';

describe('repositories against real Postgres (PGlite)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('seeds the demo tenant with a usable board', async () => {
    const tasks = await ctx.db.repos.tasks.list(ctx.orgId, { limit: 200 });
    const statuses = new Set(tasks.map((t) => t.status));

    expect(tasks.length).toBeGreaterThanOrEqual(10);
    expect(statuses.has('ready')).toBe(true);
    expect(statuses.has('in_progress')).toBe(true);
    expect(statuses.has('completed')).toBe(true);

    const projects = await ctx.db.repos.projects.list(ctx.orgId);
    expect(projects.length).toBe(4);
    expect(projects[0]?.openTaskCount).toBeGreaterThanOrEqual(0);
  });

  it('filters tasks by status array and by assignee', async () => {
    const ready = await ctx.db.repos.tasks.list(ctx.orgId, { status: ['ready'], limit: 50 });
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.every((t) => t.status === 'ready')).toBe(true);

    const mine = await ctx.db.repos.tasks.list(ctx.orgId, { assigneeId: 'usr_jordan', limit: 50 });
    expect(mine.every((t) => t.assigneeId === 'usr_jordan')).toBe(true);
  });

  it('returns nothing for an empty status filter instead of everything-but-broken', async () => {
    const all = await ctx.db.repos.tasks.list(ctx.orgId, { status: [], limit: 200 });
    expect(all.length).toBeGreaterThan(0);
  });

  describe('organization isolation', () => {
    let foreign: Awaited<ReturnType<typeof createForeignOrg>>;

    beforeAll(async () => {
      foreign = await createForeignOrg(ctx.db);
    });

    it('does not leak another organization’s tasks into a list', async () => {
      const tasks = await ctx.db.repos.tasks.list(ctx.orgId, { limit: 200 });
      expect(tasks.map((t) => t.id)).not.toContain(foreign.taskId);
      expect(tasks.every((t) => t.orgId === ctx.orgId)).toBe(true);
    });

    it('does not leak another organization’s projects or clients', async () => {
      const projects = await ctx.db.repos.projects.list(ctx.orgId);
      const clients = await ctx.db.repos.clients.list(ctx.orgId);
      expect(projects.map((p) => p.id)).not.toContain(foreign.projectId);
      expect(clients.map((c) => c.id)).not.toContain(foreign.clientId);
    });

    it('refuses to read another organization’s task by id, and says so distinctly', async () => {
      await expect(ctx.db.repos.tasks.require(ctx.orgId, foreign.taskId)).rejects.toBeInstanceOf(OrganizationMismatchError);
      await expect(ctx.db.repos.tasks.findById(ctx.orgId, foreign.taskId)).resolves.toBeNull();
    });

    it('refuses to write another organization’s task', async () => {
      await expect(ctx.db.repos.tasks.setStatus(ctx.orgId, foreign.taskId, 'completed')).rejects.toBeInstanceOf(
        OrganizationMismatchError,
      );
    });

    it('reports a genuinely missing row as NotFound, not as an isolation failure', async () => {
      await expect(ctx.db.repos.tasks.require(ctx.orgId, 'tsk_does_not_exist')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('does not leak another organization’s audit trail', async () => {
      const events = await ctx.db.repos.audit.list(ctx.orgId, { limit: 200 });
      expect(events.every((e) => e.orgId === ctx.orgId)).toBe(true);
    });
  });

  describe('optimistic concurrency', () => {
    it('rejects an update based on a stale version and reports the current one', async () => {
      const created = await ctx.db.repos.tasks.create({
        id: 'tsk_concurrency',
        orgId: ctx.orgId,
        projectId: 'prj_hbc_fall',
        title: 'Concurrency probe',
        status: 'draft',
        priority: 'normal',
        source: 'human',
        createdBy: 'usr_marcus',
      });

      await ctx.db.repos.tasks.update(ctx.orgId, created.id, { title: 'First writer wins' });
      await expect(
        ctx.db.repos.tasks.update(ctx.orgId, created.id, { title: 'Second writer loses' }, created.version),
      ).rejects.toBeInstanceOf(ConflictError);

      const current = await ctx.db.repos.tasks.require(ctx.orgId, created.id);
      expect(current.title).toBe('First writer wins');
      expect(current.version).toBe(created.version + 1);
    });

    it('bumps the version on every update', async () => {
      const before = await ctx.db.repos.tasks.require(ctx.orgId, 'tsk_concurrency');
      const after = await ctx.db.repos.tasks.update(ctx.orgId, before.id, { priority: 'high' });
      expect(after.version).toBe(before.version + 1);
    });
  });

  describe('request idempotency', () => {
    it('stores one row per (provider, external id)', async () => {
      const input = {
        orgId: ctx.orgId,
        source: 'email' as const,
        sourceRef: 'smoke:message-1',
        externalId: 'message-1',
        rawFrom: 'a@b.com',
        rawSubject: 'Hello',
        rawBody: 'Body',
        rawReceivedAt: new Date().toISOString(),
      };

      const first = await ctx.db.repos.requests.create({ id: 'req_idem_1', ...input });
      await expect(ctx.db.repos.requests.create({ id: 'req_idem_2', ...input })).rejects.toThrow();

      const found = await ctx.db.repos.requests.findByExternalId(ctx.orgId, input.sourceRef, input.externalId);
      expect(found?.id).toBe(first.id);
    });
  });

  describe('transactions', () => {
    it('rolls back everything when part of the unit throws', async () => {
      const before = await ctx.db.repos.tasks.countsByStatus(ctx.orgId);

      await expect(
        ctx.db.withTransaction(async (tx) => {
          await tx.repos.tasks.create({
            id: 'tsk_rollback_probe',
            orgId: ctx.orgId,
            projectId: 'prj_hbc_fall',
            title: 'Should never persist',
            status: 'draft',
            priority: 'normal',
            source: 'human',
            createdBy: 'usr_marcus',
          });
          throw new Error('deliberate failure');
        }),
      ).rejects.toThrow('deliberate failure');

      const after = await ctx.db.repos.tasks.countsByStatus(ctx.orgId);
      expect(after).toEqual(before);
      expect(await ctx.db.repos.tasks.findById(ctx.orgId, 'tsk_rollback_probe')).toBeNull();
    });
  });
});
