import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireActorOr401 } from '@/lib/auth';
import { getCore, isOutlookConfigured } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';
import { ValidationError } from '@flowpilot/shared';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const VERIFIER_COOKIE = 'flowpilot_outlook_verifier';
const VERIFIER_TTL_SECONDS = 60 * 15;

const QuerySchema = z.object({ returnTo: z.string().optional() });

/**
 * GET /api/integrations/outlook-graph/oauth/start
 *
 * Kicks off a Microsoft Identity Platform authorization-code+PKCE handshake:
 *   1. Generate a verifier + challenge.
 *   2. Persist a state row signed with the user's org id.
 *   3. Set a short-lived httpOnly cookie carrying the raw verifier (the IdP only
 *      sees the challenge).
 *   4. Return the authorize URL.
 *
 * The dashboard `Connect` button does an `apiFetch` then `window.location.assign`s to
 * the returned URL; the httpOnly cookie travels with the browser to the IdP and back.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<Record<string, never>> },
): Promise<Response> {
  void ctx;
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    if (!isOutlookConfigured()) {
      return errorResponse(
        new ValidationError(
          'Outlook is not configured. Set FLOWPILOT_OUTLOOK_CLIENT_ID, FLOWPILOT_OUTLOOK_TENANT_ID, FLOWPILOT_OUTLOOK_REDIRECT_URI before connecting.',
        ),
      );
    }
    const url = new URL(request.url);
    const query = QuerySchema.parse(Object.fromEntries(url.searchParams));
    const start = await getCore().oauth.startHandshake(auth.actor, {
      provider: 'outlook-graph',
      returnTo: query.returnTo ?? '/settings/integrations',
    });
    const cookieStore = await cookies();
    cookieStore.set({
      name: VERIFIER_COOKIE,
      value: start.codeVerifier,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: VERIFIER_TTL_SECONDS,
    });
    return ok({ authorizeUrl: start.authorizeUrl, state: start.state, expiresIn: start.expiresInSeconds });
  } catch (error) {
    return errorResponse(error);
  }
}
