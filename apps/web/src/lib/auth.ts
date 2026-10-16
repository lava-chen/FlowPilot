import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { UnauthenticatedError } from '@flowpilot/shared';
import type { Actor } from '@flowpilot/domain';
import { verifySessionToken } from '@flowpilot/core';

/**
 * Request identity.
 *
 * The actor always comes from a signed cookie — never from a header the client controls, and
 * never from a query parameter. In particular there is no `orgId` anywhere in the API surface:
 * an organization is a property of the session, so there is nothing for a request to lie about.
 *
 * `getActor(request)` prefers the passed `Request` and only falls back to `next/headers` when
 * called from a server component. That keeps the same logic testable from a plain `Request`.
 */
export const SESSION_COOKIE = 'flowpilot_session';

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export async function getActor(request?: Request): Promise<Actor | null> {
  const token = request
    ? readCookie(request.headers.get('cookie'), SESSION_COOKIE)
    : (await cookies()).get(SESSION_COOKIE)?.value;

  if (!token) return null;

  try {
    return await verifySessionToken(token);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return null;
    throw error;
  }
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) {
    redirect('/login');
  }
  // `redirect` returns `never` at runtime; the explicit throw keeps the type honest without
  // relying on TS to narrow across the call.
  if (!actor) throw new UnauthenticatedError('Sign in to continue.');
  return actor;
}

/** Same as `requireActor` but for route handlers, where a redirect is not a valid response. */
export async function requireActorOr401(request?: Request): Promise<{ actor: Actor } | { response: Response }> {
  const actor = await getActor(request);
  if (!actor) {
    return {
      response: Response.json(
        { error: { code: 'unauthenticated', message: 'Sign in to continue.' } },
        { status: 401 },
      ),
    };
  }
  return { actor };
}
