import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Turn a request's AI analysis into a task draft. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const { id } = await context.params;
    const core = getCore();
    const task = await core.tasks.createDraftFromRequest(auth.actor, id);

    return ok({ task, request: await core.requests.require(auth.actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
