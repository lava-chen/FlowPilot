import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor, AgentCredential, Scope } from '@flowpilot/domain';
import { newId, UnauthenticatedError } from '@flowpilot/shared';
import type { AuditService } from './audit.service.js';
import { assertCan } from './permissions.js';

/**
 * Agent credentials.
 *
 * The plaintext token exists exactly once 鈥?in the response to the creating call. Only its
 * SHA-256 hash is stored. Lookup is by hash, comparison is constant-time, and revocation is a
 * timestamp that `authenticate()` checks on every request.
 */
export class CredentialService {
  constructor(
    private readonly db: FlowPilotDb,
    private readonly audit: AuditService,
  ) {}

  async create(actor: Actor, input: { name: string; scopes: Scope[] }): Promise<{ credential: AgentCredential; token: string }> {
    assertCan(actor, 'credentials:manage');

    const token = `fp_live_${randomBytes(24).toString('base64url')}`;
    const stored = await this.db.repos.credentials.create({
      id: newId('credential'),
      orgId: actor.orgId,
      name: input.name,
      tokenPrefix: token.slice(0, 14),
      tokenHash: hashToken(token),
      scopes: input.scopes,
    });

    await this.audit.record(actor, 'credential.created', 'agent_credential', stored.id, {
      name: stored.name,
      scopes: stored.scopes,
    });

    const { tokenHash: _omitted, ...credential } = stored;
    return { credential: credential as AgentCredential, token };
  }

  async list(actor: Actor): Promise<AgentCredential[]> {
    assertCan(actor, 'credentials:manage');
    return this.db.repos.credentials.list(actor.orgId);
  }

  async revoke(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'credentials:manage');
    await this.db.repos.credentials.revoke(actor.orgId, id);
    await this.audit.record(actor, 'credential.revoked', 'agent_credential', id, {});
  }

  /**
   * Resolves a bearer token to an agent actor.
   *
   * The organization comes from the credential row 鈥?never from a parameter. An agent that
   * claims a different `orgId` in its arguments has no effect on which tenant it reads.
   */
  async authenticate(token: string): Promise<Actor> {
    if (!token || token.length < 16) throw new UnauthenticatedError('Missing or malformed agent token.');

    const stored = await this.db.repos.credentials.findByHash(hashToken(token));
    if (!stored || !hashEquals(stored.tokenHash, hashToken(token))) {
      throw new UnauthenticatedError('Agent token is not recognized.');
    }
    if (stored.revokedAt) {
      throw new UnauthenticatedError('This agent token has been revoked.');
    }

    await this.db.repos.credentials.touch(stored.id);

    return {
      kind: 'agent',
      credentialId: stored.id,
      orgId: stored.orgId,
      scopes: stored.scopes,
      label: stored.name,
    };
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
