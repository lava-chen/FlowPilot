import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FlowPilotDb, migrate, seed, DEMO_ORG_ID } from '@flowpilot/database';
import { createCoreServices, hashPassword, type CoreServices } from '@flowpilot/core';
import { createMcpApp } from '@flowpilot/mcp/app';
import { MockEmailAdapter } from '@flowpilot/integrations';

/**
 * End-to-end MCP test.
 *
 * This uses the SDK's real `Client` against the real HTTP server 鈥?the transport is not stubbed 鈥? * because "the tools are registered" and "an MCP client can actually call them over Streamable
 * HTTP" are different claims, and only the second one matters to the demo.
 */
describe('MCP server over Streamable HTTP', () => {
  let db: FlowPilotDb;
  let core: CoreServices;
  let server: Server;
  let baseUrl: string;
  let token: string;
  let wrongOrgToken: string;

  beforeAll(async () => {
    db = await FlowPilotDb.pglite();
    await migrate(db.client, { skip: ['0002_rls.sql'] });
    await seed(db.client, { demoToken: false });
    core = createCoreServices({ db });

    const owner = (await db.repos.users.listByOrg(DEMO_ORG_ID)).find((u) => u.role === 'owner')!;
    const ownerActor = {
      kind: 'user' as const,
      userId: owner.id,
      orgId: DEMO_ORG_ID,
      role: 'owner' as const,
      email: owner.email,
      displayName: owner.fullName,
    };

    const created = await core.credentials.create(ownerActor, {
      name: 'Integration test agent',
      scopes: ['projects:read', 'requests:read', 'requests:write', 'tasks:read', 'tasks:write'],
    });
    token = created.token;

    // A second tenant, to prove an agent cannot read across organizations.
    const foreign = await db.repos.organizations.create({ id: 'org_rival', name: 'Rival Studio', slug: 'rival-studio' });
    const foreignOwner = await db.repos.users.create({ id: 'usr_rival', email: 'owner@rival.test', fullName: 'Rival Owner' });
    await db.repos.memberships.create({ id: 'mem_rival', orgId: foreign.id, userId: foreignOwner.id, role: 'owner' });
    const foreignCredential = await core.credentials.create(
      { kind: 'user', userId: foreignOwner.id, orgId: foreign.id, role: 'owner', email: foreignOwner.email, displayName: foreignOwner.fullName },
      { name: 'Rival agent', scopes: ['projects:read', 'tasks:read', 'requests:read'] },
    );
    wrongOrgToken = foreignCredential.token;

    const app = createMcpApp({
      core,
      authenticate: (candidate) => core.credentials.authenticate(candidate),
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });

  const connect = async (authToken: string): Promise<Client> => {
    const client = new Client({ name: 'flowpilot-integration-test', version: '0.1.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
      }),
    );
    return client;
  };

  it('advertises every required tool', async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const required of [
      'list_projects',
      'list_tasks',
      'get_task',
      'analyze_request',
      'create_task_draft',
      'request_task_approval',
      'get_workflow_status',
    ]) {
      expect(names, `missing tool ${required}`).toContain(required);
    }

    await client.close();
  });

  it('refuses an unauthenticated request with a JSON-RPC error, not an HTML page', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe(-32001);
    expect(body.jsonrpc).toBe('2.0');
  });

  it('runs the demo loop: find requests 鈫?analyze 鈫?create drafts', async () => {
    const client = await connect(token);

    const projects = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(projects.isError).toBeFalsy();
    expect(JSON.stringify(projects.content)).toContain('HBC-FALL-LAUNCH');

    // A fresh inbound email, ingested through the same path the dashboard uses.
    const manager = (await db.repos.users.listByOrg(DEMO_ORG_ID)).find((u) => u.role === 'admin')!;
    await core.requests.ingest(
      { kind: 'user', userId: manager.id, orgId: DEMO_ORG_ID, role: 'admin', email: manager.email, displayName: manager.fullName },
      MockEmailAdapter.message('harbor-logo', 777),
    );

    const pending = (await client.callTool({ name: 'list_requests', arguments: { status: ['new'] } })) as {
      content: Array<{ text: string }>;
    };
    const pendingBody = JSON.parse(pending.content[0]!.text) as { requests: Array<{ id: string }> };
    expect(pendingBody.requests.length).toBeGreaterThan(0);

    const target = pendingBody.requests[0]!.id;

    const analyzed = (await client.callTool({ name: 'analyze_request', arguments: { requestId: target } })) as {
      content: Array<{ text: string }>;
    };
    const analyzedBody = JSON.parse(analyzed.content[0]!.text) as { analyzed: number; requests: Array<{ analysis: { projectId: string | null } }> };
    expect(analyzedBody.analyzed).toBe(1);
    expect(analyzedBody.requests[0]?.analysis.projectId).toBeTruthy();

    const drafted = (await client.callTool({ name: 'create_task_draft', arguments: { requestId: target } })) as {
      content: Array<{ text: string }>;
    };
    const draftBody = JSON.parse(drafted.content[0]!.text) as {
      task: { id: string; status: string };
      requiresHumanConfirmation: boolean;
    };
    expect(draftBody.task.status).toBe('draft');
    expect(draftBody.requiresHumanConfirmation).toBe(true);

    // The draft is a real database row the dashboard will show.
    const stored = await db.repos.tasks.require(DEMO_ORG_ID, draftBody.task.id);
    expect(stored.source).toBe('agent');
    expect(stored.requestId).toBe(target);

    const queued = (await client.callTool({
      name: 'request_task_approval',
      arguments: { taskId: draftBody.task.id },
    })) as { content: Array<{ text: string }> };
    const queuedBody = JSON.parse(queued.content[0]!.text) as { task: { status: string } };
    expect(queuedBody.task.status).toBe('pending_approval');

    await client.close();
  });

  it('cannot approve work 鈥?the human-only gate is enforced server-side', async () => {
    const client = await connect(token);

    const drafts = (await client.callTool({ name: 'list_tasks', arguments: { status: ['draft'] } })) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(drafts.content[0]!.text) as {
      tasks: Array<{ id: string; status: string; allowedTransitions: string[] }>;
    };
    const task = body.tasks[0]!;
    expect(task.status).toBe('draft');

    // The release hop 鈥?pending_approval -> ready 鈥?is not reachable from a draft at all, so the
    // agent cannot approve even if it tried to express that.
    expect(task.allowedTransitions).not.toContain('ready');
    expect(task.allowedTransitions).toEqual(expect.arrayContaining(['pending_approval']));

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('approve_task');
    expect(names).not.toContain('decide_approval');

    // Asking a human to review works exactly once per draft; a second attempt is refused.
    const first = await client.callTool({ name: 'request_task_approval', arguments: { taskId: task.id } });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({ name: 'request_task_approval', arguments: { taskId: task.id } });
    expect(second.isError).toBe(true);

    // And the task is parked for a human, not released to the team.
    const after = (await client.callTool({ name: 'get_task', arguments: { taskId: task.id } })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(after.content[0]!.text).status).toBe('pending_approval');

    await client.close();
  });

  it('reports an illegal transition with a protocol error instead of a stack trace', async () => {
    const client = await connect(token);

    const tasks = (await client.callTool({ name: 'list_tasks', arguments: { status: ['ready'] } })) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(tasks.content[0]!.text) as { tasks: Array<{ id: string; allowedTransitions: string[] }> };
    const task = body.tasks[0]!;

    // A tool that tries an illegal move surfaces it as a JSON-RPC error with our code.
    const result = (await client.callTool({
      name: 'request_task_approval',
      arguments: { taskId: task.id },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    const text = result.content.map((c) => c.text).join(' ');
    expect(text).not.toContain('at Object.');
    expect(text).not.toContain('node_modules');

    await client.close();
  });

  it('scopes an agent to its own organization', async () => {
    const client = await connect(wrongOrgToken);

    const projects = (await client.callTool({ name: 'list_projects', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(projects.content[0]!.text) as { projects: Array<{ code: string }> };

    // Rival Studio has no projects, and certainly not Northline's.
    expect(body.projects).toEqual([]);

    const tasks = (await client.callTool({ name: 'list_tasks', arguments: {} })) as { content: Array<{ text: string }> };
    expect(tasks.content[0]!.text).not.toContain('HBC-FALL-LAUNCH');

    // A Northline task id is not reachable from the other tenant.
    const crossRead = (await client.callTool({ name: 'get_task', arguments: { taskId: 'tsk_cedar_916' } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(crossRead.isError).toBe(true);

    await client.close();
  });

  it('refuses a write from a read-only credential', async () => {
    const readOnlyActor = {
      kind: 'user' as const,
      userId: 'usr_dana',
      orgId: DEMO_ORG_ID,
      role: 'owner' as const,
      email: 'dana@northlinecreative.com',
      displayName: 'Dana Reyes',
    };
    const readOnly = await core.credentials.create(readOnlyActor, {
      name: 'Read-only agent',
      scopes: ['projects:read', 'tasks:read', 'requests:read'],
    });

    const client = await connect(readOnly.token);
    const attempt = (await client.callTool({
      name: 'create_task_draft',
      arguments: { projectId: 'prj_hbc_fall', title: 'Should be refused' },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(attempt.isError).toBe(true);
    expect(attempt.content.map((c) => c.text).join(' ')).toContain('scope');

    await client.close();
  });

  it('stops working the moment a credential is revoked', async () => {
    const owner = (await db.repos.users.listByOrg(DEMO_ORG_ID)).find((u) => u.role === 'owner')!;
    const ownerActor = {
      kind: 'user' as const,
      userId: owner.id,
      orgId: DEMO_ORG_ID,
      role: 'owner' as const,
      email: owner.email,
      displayName: owner.fullName,
    };
    const shortLived = await core.credentials.create(ownerActor, {
      name: 'Short-lived agent',
      scopes: ['projects:read'],
    });

    const client = await connect(shortLived.token);
    await client.callTool({ name: 'list_projects', arguments: {} });

    await core.credentials.revoke(ownerActor, shortLived.credential.id);

    // Revocation is enforced at the door: the transport itself rejects the call rather than
    // returning a tool-level error, so a revoked agent cannot probe the API at all.
    await expect(client.callTool({ name: 'list_projects', arguments: {} })).rejects.toThrow(/revoked/i);

    await client.close();
  });

  it('records agent activity in the audit trail', async () => {
    const events = await db.repos.audit.list(DEMO_ORG_ID, { limit: 100, actorKind: 'agent' });
    const actions = events.map((e) => e.action);

    expect(actions).toContain('task.draft_created');
    expect(events.every((e) => e.actorKind === 'agent')).toBe(true);
  });

  it('exposes workflow run status with steps', async () => {
    const client = await connect(token);
    const result = (await client.callTool({ name: 'get_workflow_status', arguments: { limit: 5 } })) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(result.content[0]!.text) as { runs: Array<{ id: string; steps: Array<{ key: string }> }> };

    expect(body.runs.length).toBeGreaterThan(0);
    expect(Array.isArray(body.runs[0]?.steps)).toBe(true);

    await client.close();
  });
});

// Referenced so the import is meaningful for readers grepping the auth path.
void hashPassword;
