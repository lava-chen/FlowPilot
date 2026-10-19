import { NextRequest } from 'next/server';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** POST /api/integrations/outlook-graph/disconnect — deletes tokens, clears cursors. */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    await getCore().oauth.disconnect(auth.actor, 'outlook-graph');
    return ok({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
