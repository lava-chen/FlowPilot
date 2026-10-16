import { TransitionTaskInputSchema } from '@flowpilot/domain';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * The only endpoint that can change a task's status column.
 *
 * The state machine decides whether the move is legal; an illegal move comes back as 409 with
 * the transitions that *would* be allowed, so the UI can tell the user what to do next.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const { id } = await context.params;
    const input = await parseBody(request, TransitionTaskInputSchema);
    const core = getCore();

    const task = await core.tasks.transition(auth.actor, id, input.to, input.note);
    return ok({ task });
  } catch (error) {
    return errorResponse(error);
  }
}
