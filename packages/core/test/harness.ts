import { FlowPilotDb, migrate, seed } from '@flowpilot/database';
import { createCoreServices, type CoreServices } from '@flowpilot/core';
import type { Actor, UserActor } from '@flowpilot/domain';
import { DEMO_ORG_ID } from '@flowpilot/database';

/**
 * Shared test harness.
 *
 * Each suite gets its own in-memory PGlite database, migrated with the *production* migration
 * files and seeded with the same demo tenant. Nothing is mocked: repositories run real SQL, and
 * the AI provider is the real deterministic one unless a test opts into a stub.
 */
export interface TestContext {
  db: FlowPilotDb;
  core: CoreServices;
  orgId: string;
  actorFor(email: string): Promise<UserActor>;
  close(): Promise<void>;
}

export const OWNER_EMAIL = 'dana@northlinecreative.com';
export const ADMIN_EMAIL = 'marcus@northlinecreative.com';
export const MANAGER_EMAIL = 'priya@northlinecreative.com';
export const MEMBER_EMAIL = 'theo@northlinecreative.com';
export const MEMBER_TWO_EMAIL = 'jordan@northlinecreative.com';

export async function createTestContext(): Promise<TestContext> {
  const db = await FlowPilotDb.pglite();
  await migrate(db.client, { skip: ['0002_rls.sql'] });
  await seed(db.client, { demoToken: false });

  const core = createCoreServices({ db, encryptionSecret: 'test-session-secret-for-ai-settings' });

  const actorFor = async (email: string): Promise<UserActor> => {
    const user = await db.repos.users.findByEmail(email);
    if (!user) throw new Error(`Seeded user ${email} not found — did the seed change?`);
    const membership = await db.repos.memberships.findByUser(DEMO_ORG_ID, user.id);
    if (!membership) throw new Error(`Seeded user ${email} has no membership.`);
    return {
      kind: 'user',
      userId: user.id,
      orgId: DEMO_ORG_ID,
      role: membership.role,
      email: user.email,
      displayName: user.fullName,
    };
  };

  return {
    db,
    core,
    orgId: DEMO_ORG_ID,
    actorFor,
    close: () => db.close(),
  };
}

export function agentActor(input: { orgId?: string; scopes?: Actor extends { scopes: infer S } ? S : never; label?: string } = {}): Actor {
  return {
    kind: 'agent',
    credentialId: 'cred_test_agent',
    orgId: input.orgId ?? DEMO_ORG_ID,
    scopes: input.scopes ?? ['projects:read', 'requests:read', 'requests:write', 'tasks:read', 'tasks:write'],
    label: input.label ?? 'Test agent',
  } as Actor;
}

/** A second, isolated tenant used to prove organization isolation. */
export async function createForeignOrg(db: FlowPilotDb, name = 'Rival Studio'): Promise<{ orgId: string; clientId: string; projectId: string; taskId: string }> {
  const org = await db.repos.organizations.create({ id: 'org_rival', name, slug: 'rival-studio' });
  const user = await db.repos.users.create({ id: 'usr_rival_1', email: 'owner@rivalstudio.test', fullName: 'Rival Owner' });
  await db.repos.memberships.create({ id: 'mem_rival_1', orgId: org.id, userId: user.id, role: 'owner' });
  const client = await db.repos.clients.create({ id: 'cli_rival', orgId: org.id, name: 'Rival Client Co.' });
  const project = await db.repos.projects.create({
    id: 'prj_rival',
    orgId: org.id,
    clientId: client.id,
    name: 'Rival Campaign',
    code: 'RIVAL-001',
  });
  const task = await db.repos.tasks.create({
    id: 'tsk_rival_secret',
    orgId: org.id,
    projectId: project.id,
    title: 'Confidential rival work',
    status: 'ready',
    priority: 'high',
    source: 'human',
    createdBy: user.id,
  });
  return { orgId: org.id, clientId: client.id, projectId: project.id, taskId: task.id };
}
