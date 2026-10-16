import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor, Membership, User, UserActor } from '@flowpilot/domain';
import { getEnv, UnauthenticatedError, ValidationError } from '@flowpilot/shared';

/**
 * Session issuing for the local Auth provider.
 *
 * The token is an ordinary HS256 JWT whose claims deliberately mirror Supabase Auth's:
 * `sub` is the user id, and the membership context (`org_id`, `role`, `email`) travels in
 * `app_metadata`. Switching `AUTH_PROVIDER=supabase` means validating a different issuer with
 * the same downstream claims 鈥?no service code changes.
 */

const ISSUER = 'flowpilot';
const AUDIENCE = 'flowpilot-dashboard';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

export interface SessionClaims {
  sub: string;
  email: string;
  name: string;
  org_id: string;
  role: string;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getEnv().SESSION_SECRET);
}

export async function issueSessionToken(input: { user: User; membership: Membership }): Promise<{ token: string; expiresAt: string }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SESSION_TTL_SECONDS;

  const token = await new SignJWT({
    email: input.user.email,
    name: input.user.fullName,
    app_metadata: { org_id: input.membership.orgId, role: input.membership.role },
    org_id: input.membership.orgId,
    role: input.membership.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(secretKey());

  return { token, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

export async function verifySessionToken(token: string): Promise<UserActor> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, audience: AUDIENCE });
    const orgId = typeof payload['org_id'] === 'string' ? payload['org_id'] : null;
    const role = typeof payload['role'] === 'string' ? payload['role'] : null;
    if (!payload.sub || !orgId || !role) throw new Error('missing claims');
    return {
      kind: 'user',
      userId: payload.sub,
      orgId,
      role: role as UserActor['role'],
      email: typeof payload['email'] === 'string' ? payload['email'] : '',
      displayName: typeof payload['name'] === 'string' ? payload['name'] : 'Unknown',
    };
  } catch {
    throw new UnauthenticatedError('Your session is invalid or has expired. Sign in again.');
  }
}

/** Password hashing for the local provider (scrypt, per-user salt). */
export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): { hash: string; salt: string } {
  return { hash: scryptSync(password, salt, 32).toString('hex'), salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export const DEMO_PASSWORD_HASH_INPUT = 'demo1234';

export interface LocalAuthResult {
  token: string;
  expiresAt: string;
  actor: UserActor;
  user: User;
  organization: { id: string; name: string; slug: string } | null;
}

/** Email + password sign-in against the local credentials table. */
export async function authenticateWithPassword(
  db: FlowPilotDb,
  input: { email: string; password: string; orgSlug?: string },
): Promise<LocalAuthResult> {
  const user = await db.repos.users.findByEmail(input.email);
  if (!user) throw new UnauthenticatedError('Incorrect email or password.');

  const credential = await db.client.one<{ password_hash: string; password_salt: string }>(
    'select password_hash, password_salt from local_credentials where user_id = $1',
    [user.id],
  );
  if (!credential || !verifyPassword(input.password, credential.password_hash, credential.password_salt)) {
    throw new UnauthenticatedError('Incorrect email or password.');
  }

  const org =
    (input.orgSlug ? await db.repos.organizations.findBySlug(input.orgSlug) : null) ??
    (await db.repos.organizations.findBySlug('northline-creative')) ??
    (await firstOrganization(db));

  if (!org) throw new ValidationError('No organization exists yet. Run `pnpm db:seed`.');

  const membership = await db.repos.memberships.findByUser(org.id, user.id);
  if (!membership) throw new UnauthenticatedError('This account is not a member of that organization.');

  const { token, expiresAt } = await issueSessionToken({ user, membership });

  return {
    token,
    expiresAt,
    user,
    organization: { id: org.id, name: org.name, slug: org.slug },
    actor: {
      kind: 'user',
      userId: user.id,
      orgId: org.id,
      role: membership.role,
      email: user.email,
      displayName: user.fullName,
    },
  };
}

async function firstOrganization(db: FlowPilotDb): Promise<{ id: string; name: string; slug: string } | null> {
  const row = await db.client.one<{ id: string; name: string; slug: string }>(
    'select id, name, slug from organizations order by created_at limit 1',
  );
  return row ?? null;
}

export type { Actor };
