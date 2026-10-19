import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Per-action event log — every state transition + send attempt + provider status callback.
 * The dashboard uses this to render the "why is this in `failed`?" tooltip.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const events = await getCore().outbounds.listEvents(auth.actor, (await ctx.params).id);
    return ok({ events });
  } catch (error) {
    return errorResponse(error);
  }
}
