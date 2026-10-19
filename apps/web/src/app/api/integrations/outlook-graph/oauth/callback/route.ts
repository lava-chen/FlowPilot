import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse } from '@/lib/http';
import { ValidationError } from '@flowpilot/shared';

export const dynamic = 'force-dynamic';

const COOKIE_VERIFIER = 'flowpilot_outlook_verifier';

const CallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

/**
 * GET /api/integrations/outlook-graph/oauth/callback
 *
 * Microsoft redirects the user's browser here with `?code=...&state=...`. We:
 *   1. Verify the authenticated session matches the org that started the handshake
 *      (the state row carries the `org_id`, so this is implicit).
 *   2. Pull the PKCE verifier from the short-lived httpOnly cookie set by
 *      `/oauth/start`.
 *   3. Exchange `code` + verifier for tokens; persist encrypted blobs.
 *
 * On success we 302 to `/settings/integrations?outlook=connected`; on failure the same
 * path with `?outlook=error&reason=...`.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<Record<string, never>> },
): Promise<Response> {
  void ctx;
  try {
    const url = new URL(request.url);
    void url;
    const parsed = CallbackSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return redirectWithError('Missing code or state in callback URL.');
    }
    if (parsed.data.error) {
      return redirectWithError(`${parsed.data.error}${parsed.data.error_description ? ': ' + parsed.data.error_description : ''}`);
    }

    const auth = await requireActorOr401(request);
    if ('response' in auth) {
      // No session cookie — send the user back to login (the IdP callback lost the
      // session because it was a cross-origin redirect).
      return Response.redirect(new URL('/login?outlook=callback', request.url), 302);
    }

    const cookieStore = await cookies();
    const verifierCookie = cookieStore.get(COOKIE_VERIFIER);
    if (!verifierCookie?.value) {
      return redirectWithError('PKCE verifier cookie missing or expired. Restart the connect flow.');
    }
    // Erase the verifier cookie regardless of outcome — it's single use.
    cookieStore.set({
      name: COOKIE_VERIFIER,
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });

    let result;
    try {
      result = await getCore().oauth.completeHandshake(auth.actor, {
        provider: 'outlook-graph',
        code: parsed.data.code,
        state: parsed.data.state,
        codeVerifier: verifierCookie.value,
      });
    } catch (error) {
      const reason = error instanceof ValidationError ? error.message : 'Microsoft rejected the callback.';
      return redirectWithError(reason);
    }
    void result;
    return Response.redirect(new URL('/settings/integrations?outlook=connected', request.url), 302);
  } catch (error) {
    return errorResponse(error);
  }
}

function redirectWithError(reason: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `/settings/integrations?outlook=error&reason=${encodeURIComponent(reason)}`,
    },
  });
}
