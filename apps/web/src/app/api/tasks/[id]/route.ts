import { UpdateTaskInputSchema } from '@flowpilot/domain';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';
import { can } from '@flowpilot/core';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const { id } = await context.params;
    const core = getCore();
    const detail = await core.queries.taskDetail(auth.actor, id);

    return ok({
      ...detail,
      availableActions: await core.tasks.availableActions(auth.actor, detail.task),
      canApprove: (detail.task.status === 'draft' || detail.task.status === 'pending_approval') && can(auth.actor, 'approvals:decide'),
      canContribute: can(auth.actor, 'tasks:contribute', { assigneeId: detail.task.assigneeId }),
      canManage: can(auth.actor, 'tasks:write'),
      blockedActions: await core.tasks.blockedActions(auth.actor, detail.task),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Edit task fields. Status is deliberately not part of this payload — see /transition. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const { id } = await context.params;
    const input = await parseBody(request, UpdateTaskInputSchema);
    const core = getCore();
    const task = await core.tasks.update(auth.actor, id, input);

    return ok({ task });
  } catch (error) {
    return errorResponse(error);
  }
}
