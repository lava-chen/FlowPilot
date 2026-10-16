import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlowPilotDb, migrate, seed, DEMO_ORG_ID } from '@flowpilot/database';
import { createCoreServices, issueSessionToken, type CoreServices } from '@flowpilot/core';
import { InboxTriggerService } from '@flowpilot/integrations';
import type { Actor } from '@flowpilot/domain';
import { getEnv, resetEnvCache } from '@flowpilot/shared';

/**
 * HTTP API integration tests.
 *
 * The route handlers are exercised as `Request` → handler → database → `Response`. Only the
 * browser is absent, so auth, permissions, validation and status mapping are all real.
 */

let db: FlowPilotDb;
let core: CoreServices;

async function actorFor(email: string): Promise<Actor> {
  const user = await db.repos.users.findByEmail(email);
  const membership = user ? await db.repos.memberships.findByUser(DEMO_ORG_ID, user.id) : null;
  if (!user || !membership) throw new Error(`missing seeded user ${email}`);
  return { kind: 'user', userId: user.id, orgId: DEMO_ORG_ID, role: membership.role, email: user.email, displayName: user.fullName };
}

async function sessionHeaders(email: string): Promise<Record<string, string>> {
  const actor = await actorFor(email);
  const user = (await db.repos.users.findById(actor.userId))!;
  const membership = (await db.repos.memberships.findByUser(DEMO_ORG_ID, actor.userId))!;
  const { token } = await issueSessionToken({ user, membership });
  return { cookie: `flowpilot_session=${encodeURIComponent(token)}`, 'content-type': 'application/json' };
}

const json = (body: unknown) => JSON.stringify(body);

describe('HTTP API', () => {
  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://flowpilot:flowpilot@localhost:5432/flowpilot',
      SESSION_SECRET: 'integration-test-secret-at-least-32-chars',
      AUTH_PROVIDER: 'local',
      FLOWPILOT_DEMO_MODE: 'true',
      NODE_ENV: 'test',
    });
    resetEnvCache();
    getEnv();

    db = await FlowPilotDb.pglite();
    await migrate(db.client, { skip: ['0002_rls.sql'] });
    await seed(db.client, { demoToken: false });
    core = createCoreServices({ db, encryptionSecret: getEnv().SESSION_SECRET });

    // Point the app's runtime singleton at the in-memory database. In production this is built
    // from DATABASE_URL on first request; here it is pre-seeded so route handlers are real.
    (globalThis as Record<string, unknown>)['__flowpilot'] = {
      db,
      core,
      inbox: new InboxTriggerService(core),
    };
  });

  afterAll(async () => {
    await db.close();
    delete (globalThis as Record<string, unknown>)['__flowpilot'];
  });

  it('401s every authenticated route without a session cookie', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request('http://localhost/api/tasks'));

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unauthenticated');
  });

  it('lets an admin configure AI settings without returning the saved key, and denies members', async () => {
    const { GET, PUT } = await import('@/app/api/settings/ai/route');
    const adminHeaders = await sessionHeaders('marcus@northlinecreative.com');
    const save = await PUT(new Request('http://localhost/api/settings/ai', {
      method: 'PUT',
      headers: adminHeaders,
      body: json({ provider: 'openai-compatible', baseUrl: 'https://api.example.test/v1', model: 'fixture-model', apiKey: 'never-return-this-key' }),
    }));
    expect(save.status).toBe(200);
    const savedBody = await save.json() as { settings: { provider: string; model: string; keyConfigured: boolean } };
    expect(savedBody.settings).toMatchObject({ provider: 'openai-compatible', model: 'fixture-model', keyConfigured: true });
    expect(JSON.stringify(savedBody)).not.toContain('never-return-this-key');

    const read = await GET(new Request('http://localhost/api/settings/ai', { headers: adminHeaders }));
    expect(read.status).toBe(200);
    expect(await read.text()).not.toContain('never-return-this-key');

    const memberHeaders = await sessionHeaders('theo@northlinecreative.com');
    const denied = await GET(new Request('http://localhost/api/settings/ai', { headers: memberHeaders }));
    expect(denied.status).toBe(403);
  });

  it('rejects a bad password but accepts the demo one with an HttpOnly cookie', async () => {
    const { POST: login } = await import('@/app/api/auth/login/route');

    const bad = await login(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json({ email: 'marcus@northlinecreative.com', password: 'wrong-password' }),
      }),
    );
    expect(bad.status).toBe(401);

    const good = await login(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json({ email: 'marcus@northlinecreative.com', password: 'demo1234' }),
      }),
    );
    expect(good.status).toBe(200);

    const setCookie = good.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('flowpilot_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const body = (await good.json()) as { user: { email: string }; role: string; organization: { slug: string } };
    expect(body.user.email).toBe('marcus@northlinecreative.com');
    expect(body.role).toBe('admin');
    expect(body.organization.slug).toBe('northline-creative');
  });

  it('validates the login body instead of failing deep in the auth layer', async () => {
    const { POST: login } = await import('@/app/api/auth/login/route');
    const response = await login(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json({ email: 'not-an-email', password: '' }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; details: Record<string, string[]> } };
    expect(body.error.code).toBe('validation_failed');
    expect(Object.keys(body.error.details)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('lists tasks with their project names for a signed-in user', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(
      new Request('http://localhost/api/tasks', { headers: await sessionHeaders('marcus@northlinecreative.com') }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tasks: Array<{ id: string; projectName: string; status: string }> };
    expect(body.tasks.length).toBeGreaterThan(0);
    expect(body.tasks[0]?.projectName).toBeTruthy();
  });

  it('drives a simulated email all the way to completed over HTTP, persisting every hop', async () => {
    const headers = await sessionHeaders('marcus@northlinecreative.com');
    const { POST: simulate } = await import('@/app/api/integrations/mock-email/route');
    const { POST: approve } = await import('@/app/api/tasks/[id]/approve/route');
    const { POST: transition } = await import('@/app/api/tasks/[id]/transition/route');

    const simulated = await simulate(
      new Request('http://localhost/api/integrations/mock-email', {
        method: 'POST',
        headers,
        body: json({ templateId: 'harbor-logo', autoCreateDraft: true }),
      }),
    );
    expect(simulated.status).toBe(200);
    const taskId = ((await simulated.json()) as { draft: { id: string } | null }).draft?.id;
    expect(taskId).toBeTruthy();

    const params = Promise.resolve({ id: taskId! });

    const approved = await approve(
      new Request(`http://localhost/api/tasks/${taskId}/approve`, {
        method: 'POST',
        headers,
        body: json({ decision: 'approved', note: 'Approved from the API test.' }),
      }),
      { params },
    );
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { task: { status: string } }).task.status).toBe('ready');

    for (const to of ['in_progress', 'in_review', 'completed']) {
      const response = await transition(
        new Request(`http://localhost/api/tasks/${taskId}/transition`, {
          method: 'POST',
          headers,
          body: json({ to }),
        }),
        { params },
      );
      expect(response.status, `transition to ${to}`).toBe(200);
    }

    // Read the row back from the database rather than trusting the responses.
    expect((await db.repos.tasks.require(DEMO_ORG_ID, taskId!)).status).toBe('completed');
  });

  it('returns 409 with the legal transitions when a move is illegal', async () => {
    const headers = await sessionHeaders('priya@northlinecreative.com');
    const { POST: transition } = await import('@/app/api/tasks/[id]/transition/route');

    const response = await transition(
      new Request('http://localhost/api/tasks/tsk_cedar_916/transition', {
        method: 'POST',
        headers,
        body: json({ to: 'completed' }),
      }),
      { params: Promise.resolve({ id: 'tsk_cedar_916' }) },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; details: { from: string; to: string; allowed: string[] } } };
    expect(body.error.code).toBe('invalid_transition');
    expect(body.error.details.from).toBe('ready');
    expect(body.error.details.allowed).toEqual(expect.arrayContaining(['in_progress']));
  });

  it('returns 403 when a member tries to approve', async () => {
    const headers = await sessionHeaders('theo@northlinecreative.com');
    const { POST: approve } = await import('@/app/api/tasks/[id]/approve/route');

    const response = await approve(
      new Request('http://localhost/api/tasks/tsk_hbc_logo/approve', {
        method: 'POST',
        headers,
        body: json({ decision: 'approved' }),
      }),
      { params: Promise.resolve({ id: 'tsk_hbc_logo' }) },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('never leaks another organization through the API', async () => {
    const headers = await sessionHeaders('marcus@northlinecreative.com');
    const { GET: getTask } = await import('@/app/api/tasks/[id]/route');

    const response = await getTask(new Request('http://localhost/api/tasks/tsk_rival_secret', { headers }), {
      params: Promise.resolve({ id: 'tsk_rival_secret' }),
    });

    // 404, never 200 and never a row from the other tenant.
    expect(response.status).toBe(404);
  });

  it('serves the overview read model', async () => {
    const { GET } = await import('@/app/api/overview/route');
    const response = await GET(
      new Request('http://localhost/api/overview', { headers: await sessionHeaders('dana@northlinecreative.com') }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { metrics: { openTasks: number }; workload: unknown[]; pendingApprovals: unknown[] };
    expect(body.metrics.openTasks).toBeGreaterThan(0);
    expect(Array.isArray(body.workload)).toBe(true);
  });

  it('serves the inbox read model with AI analysis attached', async () => {
    const { GET } = await import('@/app/api/requests/route');
    const response = await GET(
      new Request('http://localhost/api/requests', { headers: await sessionHeaders('priya@northlinecreative.com') }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { requests: Array<{ id: string; analysis: unknown; rawBody: string }> };
    expect(body.requests.length).toBeGreaterThan(0);
    expect(body.requests.some((r) => r.analysis !== null)).toBe(true);
    expect(body.requests.every((r) => typeof r.rawBody === 'string')).toBe(true);
  });

  it('surfaces activity including agent-originated events', async () => {
    const { GET } = await import('@/app/api/activity/route');
    const response = await GET(
      new Request('http://localhost/api/activity', { headers: await sessionHeaders('dana@northlinecreative.com') }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: unknown[]; audit: Array<{ actorKind: string }>; agentCalls: unknown[] };
    expect(body.runs.length).toBeGreaterThan(0);
    expect(body.audit.some((e) => e.actorKind === 'agent')).toBe(true);
  });

  it('de-duplicates a replayed inbound email instead of creating a second request', async () => {
    const actor = await actorFor('marcus@northlinecreative.com');
    const message = {
      provider: 'mock-email',
      externalId: 'replay-probe-1',
      from: 'dev@lumenfitness.com',
      subject: 'Replayed webhook',
      body: 'Testing duplicate protection for a redelivered message.',
    };

    const first = await core.requests.ingest(actor, message);
    const second = await core.requests.ingest(actor, message);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.request.id).toBe(first.request.id);

    const rows = await db.repos.requests.list(DEMO_ORG_ID, { limit: 200 });
    expect(rows.filter((r) => r.externalId === 'replay-probe-1')).toHaveLength(1);
  });

  it('edits a task field and records it in the audit trail', async () => {
    const headers = await sessionHeaders('marcus@northlinecreative.com');
    const { PATCH } = await import('@/app/api/tasks/[id]/route');

    const response = await PATCH(
      new Request('http://localhost/api/tasks/tsk_lumen_15s', {
        method: 'PATCH',
        headers,
        body: json({ title: 'Cut 15s retargeting variant (revised brief)', priority: 'high' }),
      }),
      { params: Promise.resolve({ id: 'tsk_lumen_15s' }) },
    );

    expect(response.status).toBe(200);
    const updated = (await response.json()) as { task: { title: string; priority: string; version: number } };
    expect(updated.task.title).toContain('revised brief');
    expect(updated.task.priority).toBe('high');

    const audit = await db.repos.audit.list(DEMO_ORG_ID, { limit: 50, entityType: 'task', entityId: 'tsk_lumen_15s' });
    expect(audit.some((e) => e.action === 'task.updated')).toBe(true);
  });

  it('rejects an optimistic-concurrency conflict with 409', async () => {
    const headers = await sessionHeaders('marcus@northlinecreative.com');
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const before = await db.repos.tasks.require(DEMO_ORG_ID, 'tsk_lumen_15s');

    // Someone else edits first.
    await PATCH(
      new Request('http://localhost/api/tasks/tsk_lumen_15s', {
        method: 'PATCH',
        headers,
        body: json({ description: 'edited by a colleague' }),
      }),
      { params: Promise.resolve({ id: 'tsk_lumen_15s' }) },
    );

    // Our stale version is refused.
    const stale = await PATCH(
      new Request('http://localhost/api/tasks/tsk_lumen_15s', {
        method: 'PATCH',
        headers,
        body: json({ description: 'edited by me, from an old screen', expectedVersion: before.version }),
      }),
      { params: Promise.resolve({ id: 'tsk_lumen_15s' }) },
    );

    expect(stale.status).toBe(409);
  });
});
