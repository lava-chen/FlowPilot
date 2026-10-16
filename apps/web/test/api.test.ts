import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FlowPilotDb, migrate, seed, DEMO_ORG_ID } from '@flowpilot/database';
import { createCoreServices, issueSessionToken, type CoreServices } from '@flowpilot/core';
import { InboxTriggerService } from '@flowpilot/integrations';
import { createMcpApp } from '@flowpilot/mcp/app';
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

  it('runs one request from simulated email through MCP, human approval, client sign-off, and activity', async () => {
    const owner = await actorFor('dana@northlinecreative.com');
    const manager = await actorFor('marcus@northlinecreative.com');
    // Earlier API tests exercise saving a remote provider; reset this throwaway tenant to the
    // deterministic analyzer so this end-to-end flow remains offline and reproducible.
    await core.aiSettings.save(manager, { provider: 'deterministic' });
    const credential = await core.credentials.create(owner, {
      name: 'Cross-surface E2E agent',
      scopes: ['projects:read', 'requests:read', 'requests:write', 'tasks:read', 'tasks:write'],
    });
    const app = createMcpApp({ core, authenticate: (value) => core.credentials.authenticate(value) });
    let server: Server | undefined;
    let agent: Client | undefined;

    try {
      await new Promise<void>((resolve) => {
        server = app.listen(0, resolve);
      });
      const { port } = server.address() as AddressInfo;
      agent = new Client({ name: 'flowpilot-cross-surface-e2e', version: '0.1.0' });
      await agent.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
        }),
      );

      const dashboardHeaders = await sessionHeaders('marcus@northlinecreative.com');
      const { POST: simulateEmail } = await import('@/app/api/integrations/mock-email/route');
      const simulated = await simulateEmail(new Request('http://localhost/api/integrations/mock-email', {
        method: 'POST',
        headers: dashboardHeaders,
        body: json({ templateId: 'harbor-logo', autoCreateDraft: false }),
      }));
      expect(simulated.status).toBe(200);
      const requestId = ((await simulated.json()) as { request: { id: string } }).request.id;

      const listed = await agent.callTool({ name: 'list_requests', arguments: { status: ['new'] } });
      expect(listed.isError).toBeFalsy();
      const listedBody = JSON.parse(listed.content[0]!.text!) as { requests: Array<{ id: string }> };
      expect(listedBody.requests.some((request) => request.id === requestId)).toBe(true);

      const analyzed = await agent.callTool({ name: 'analyze_request', arguments: { requestId } });
      expect(analyzed.isError).toBeFalsy();
      const analyzedBody = JSON.parse(analyzed.content[0]!.text!) as {
        analyzed: number;
        requests: Array<{ id: string; analysis: { projectId: string | null } }>;
      };
      expect(analyzedBody.analyzed, JSON.stringify(analyzedBody.errors)).toBe(1);
      expect(analyzedBody.requests[0]).toMatchObject({ id: requestId, analysis: { projectId: expect.any(String) } });

      const drafted = await agent.callTool({ name: 'create_task_draft', arguments: { requestId } });
      expect(drafted.isError).toBeFalsy();
      const draftBody = JSON.parse(drafted.content[0]!.text!) as {
        task: { id: string; status: string };
        requiresHumanConfirmation: boolean;
      };
      const taskId = draftBody.task.id;
      expect(draftBody).toMatchObject({ task: { status: 'draft' }, requiresHumanConfirmation: true });
      expect((await agent.listTools()).tools.map((tool) => tool.name)).not.toContain('approve_task');

      const queued = await agent.callTool({ name: 'request_task_approval', arguments: { taskId } });
      expect(queued.isError).toBeFalsy();
      expect(JSON.parse(queued.content[0]!.text!).task.status).toBe('pending_approval');

      const params = Promise.resolve({ id: taskId });
      const { PATCH: updateTask } = await import('@/app/api/tasks/[id]/route');
      const assigned = await updateTask(new Request(`http://localhost/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: dashboardHeaders,
        body: json({ assigneeId: 'usr_theo' }),
      }), { params });
      expect(assigned.status).toBe(200);

      const { POST: approve } = await import('@/app/api/tasks/[id]/approve/route');
      const approved = await approve(new Request(`http://localhost/api/tasks/${taskId}/approve`, {
        method: 'POST',
        headers: dashboardHeaders,
        body: json({ decision: 'approved', note: 'Approved by the project manager.' }),
      }), { params });
      expect(approved.status).toBe(200);
      expect(((await approved.json()) as { task: { status: string } }).task.status).toBe('ready');

      const { POST: taskOperation } = await import('@/app/api/tasks/[id]/operations/route');
      const checklistResponse = await taskOperation(new Request(`http://localhost/api/tasks/${taskId}/operations`, {
        method: 'POST', headers: dashboardHeaders, body: json({ operation: 'add_checklist', title: 'Check logo scale and end-card duration' }),
      }), { params });
      expect(checklistResponse.status).toBe(200);
      const checklistId = ((await checklistResponse.json()) as { item: { id: string } }).item.id;

      const { POST: transition } = await import('@/app/api/tasks/[id]/transition/route');
      const move = async (to: string) => transition(new Request(`http://localhost/api/tasks/${taskId}/transition`, {
        method: 'POST', headers: dashboardHeaders, body: json({ to }),
      }), { params });
      expect((await move('in_progress')).status).toBe(200);

      const checklistDone = await taskOperation(new Request(`http://localhost/api/tasks/${taskId}/operations`, {
        method: 'POST', headers: dashboardHeaders,
        body: json({ operation: 'update_checklist', itemId: checklistId, isComplete: true }),
      }), { params });
      expect(checklistDone.status).toBe(200);

      const deliveryLink = await taskOperation(new Request(`http://localhost/api/tasks/${taskId}/operations`, {
        method: 'POST', headers: dashboardHeaders,
        body: json({ operation: 'add_link', label: 'Final review cut', url: 'https://example.com/harbor-final-cut', kind: 'delivery' }),
      }), { params });
      expect(deliveryLink.status).toBe(200);
      expect((await move('in_review')).status).toBe(200);

      const reviewRequested = await taskOperation(new Request(`http://localhost/api/tasks/${taskId}/operations`, {
        method: 'POST', headers: dashboardHeaders, body: json({ operation: 'request_client_review' }),
      }), { params });
      expect(reviewRequested.status).toBe(200);
      const reviewUrl = ((await reviewRequested.json()) as { url: string }).url;
      const reviewToken = new URL(reviewUrl).pathname.split('/').at(-1)!;

      const { GET: clientPortal, POST: clientDecision } = await import('@/app/api/client-review/[token]/route');
      const portal = await clientPortal(new Request(reviewUrl), { params: Promise.resolve({ token: reviewToken }) });
      expect(portal.status).toBe(200);
      expect(JSON.stringify(await portal.json())).toContain('Final review cut');

      const clientAccepted = await clientDecision(new Request(reviewUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json({ decision: 'approved', reviewerName: 'Alice Nguyen', reviewerEmail: 'alice@harborcoffee.com' }),
      }), { params: Promise.resolve({ token: reviewToken }) });
      expect(clientAccepted.status).toBe(200);
      expect((await move('completed')).status).toBe(200);
      expect((await db.repos.tasks.require(DEMO_ORG_ID, taskId)).status).toBe('completed');

      const { GET: activity } = await import('@/app/api/activity/route');
      const activityResponse = await activity(new Request('http://localhost/api/activity', { headers: dashboardHeaders }));
      expect(activityResponse.status).toBe(200);
      const activityBody = await activityResponse.json() as { audit: Array<{ action: string; entityId: string; actorKind: string }> };
      const taskActions = activityBody.audit.filter((event) => event.entityId === taskId).map((event) => event.action);
      expect(taskActions).toEqual(expect.arrayContaining([
        'task.draft_created', 'approval.decided', 'task.start', 'task.submit', 'task.complete', 'task.client_review_approved',
      ]));
      expect(activityBody.audit.some((event) => event.entityId === taskId && event.actorKind === 'agent')).toBe(true);
      expect((await db.repos.audit.list(DEMO_ORG_ID, { limit: 100, entityType: 'request', entityId: requestId }))
        .map((event) => event.action)).toEqual(expect.arrayContaining(['request.ingested', 'request.analyzed']));
    } finally {
      await agent?.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
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
