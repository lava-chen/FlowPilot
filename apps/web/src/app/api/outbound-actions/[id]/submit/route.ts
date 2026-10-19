import { z } from 'zod';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

const SubmitSchema = z.object({ note: z.string().max(500).optional() });

/**
 * `draft -> pending_approval`. Either a human or a system/agent can submit.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    await parseBody(request, SubmitSchema).catch(() => ({})); // body is optional
    const { id } = await ctx.params;
    const action = await getCore().outbounds.submitForApproval(auth.actor, id);
    return ok({ action });
  } catch (error) {
    return errorResponse(error);
  }
}
