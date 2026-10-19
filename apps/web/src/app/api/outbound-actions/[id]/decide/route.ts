import { z } from 'zod';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

const DecideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(500).optional(),
});

/**
 * Human-only `pending_approval -> approved | rejected` decision.
 *
 * The state machine forbids an agent from reaching this route even when the credential
 * somehow carries `tasks:write` — the service rejects non-`user` actors with `ForbiddenError`.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const input = await parseBody(request, DecideSchema);
    const action = await getCore().outbounds.decide(auth.actor, {
      actionId: (await ctx.params).id,
      decision: input.decision,
      note: input.note ?? null,
    });
    return ok({ action });
  } catch (error) {
    return errorResponse(error);
  }
}
