import { DecideApprovalInputSchema } from '@flowpilot/domain';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Human approval / rejection.
 *
 * There is deliberately no agent-reachable path to this route: the session behind it is always a
 * user actor, and `approvals:decide` is unreachable from any agent scope.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const { id } = await context.params;
    const input = await parseBody(request, DecideApprovalInputSchema);
    const core = getCore();

    const result = await core.approvals.decide(auth.actor, { taskId: id, decision: input.decision, note: input.note });
    return ok(result);
  } catch (error) {
    return errorResponse(error);
  }
}
