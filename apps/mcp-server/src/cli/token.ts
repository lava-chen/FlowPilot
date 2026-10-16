#!/usr/bin/env node
import { FlowPilotDb } from '@flowpilot/database';
import { createCoreServices } from '@flowpilot/core';
import { getEnv } from '@flowpilot/shared';
import type { Scope } from '@flowpilot/domain';

/**
 * Issues an agent credential bound to the demo organization.
 *
 * The plaintext token is printed once and only its hash is stored. Usage:
 *   pnpm agent:token --name "Claude Desktop" --scopes requests:read,tasks:read,tasks:write
 */
function parseArgs(argv: string[]): { name: string; scopes: Scope[] } {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const allScopes: Scope[] = ['projects:read', 'requests:read', 'requests:write', 'tasks:read', 'tasks:write'];
  const rawScopes = get('--scopes');

  return {
    name: get('--name') ?? 'CLI agent',
    scopes: rawScopes
      ? (rawScopes.split(',').map((s) => s.trim()).filter(Boolean) as Scope[])
      : allScopes,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = FlowPilotDb.connect();
  const core = createCoreServices({ db });

  try {
    const org = await db.repos.organizations.findBySlug('northline-creative');
    if (!org) throw new Error('No organization found. Run `pnpm db:seed` first.');

    // The token is created by core with a synthetic owner actor; it is an operator action.
    const owner = await db.repos.users.listByOrg(org.id);
    const ownerUser = owner.find((u) => u.role === 'owner');
    if (!ownerUser) throw new Error('No owner membership found. Run `pnpm db:seed` first.');

    const { token, credential } = await core.credentials.create(
      {
        kind: 'user',
        userId: ownerUser.id,
        orgId: org.id,
        role: 'owner',
        email: ownerUser.email,
        displayName: ownerUser.fullName,
      },
      { name: args.name, scopes: args.scopes },
    );

    console.log('✔ Agent credential created (the token is shown only once):');
    console.log('');
    console.log(`  name:    ${credential.name}`);
    console.log(`  scopes:  ${credential.scopes.join(', ')}`);
    console.log(`  token:   ${token}`);
    console.log('');
    console.log('  MCP client config:');
    console.log(JSON.stringify({ mcpServers: { flowpilot: { type: 'http', url: getEnv().MCP_PUBLIC_URL, headers: { Authorization: `Bearer ${token}` } } } }, null, 2));
  } finally {
    await db.close();
  }
}

void main().catch((error: unknown) => {
  console.error('✖', error instanceof Error ? error.message : error);
  process.exit(1);
});
