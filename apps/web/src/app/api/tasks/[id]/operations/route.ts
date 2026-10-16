import { TaskOperationInputSchema } from '@flowpilot/domain';
import { getEnv } from '@flowpilot/shared';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const { id } = await context.params;
    const input = await parseBody(request, TaskOperationInputSchema);
    const core = getCore();

    switch (input.operation) {
      case 'add_checklist': return ok({ item: await core.taskOperations.addChecklistItem(auth.actor, id, input.title) });
      case 'update_checklist': return ok({ item: await core.taskOperations.updateChecklistItem(auth.actor, id, input.itemId, input) });
      case 'add_comment': return ok({ comment: await core.taskOperations.addComment(auth.actor, id, input.body) });
      case 'add_link': return ok({ link: await core.taskOperations.addLink(auth.actor, id, input) });
      case 'log_time': return ok({ entry: await core.taskOperations.logTime(auth.actor, id, input) });
      case 'add_dependency': return ok({ dependencies: await core.taskOperations.addDependency(auth.actor, id, input.dependsOnTaskId) });
      case 'remove_dependency': await core.taskOperations.removeDependency(auth.actor, id, input.dependsOnTaskId); return ok({ ok: true });
      case 'request_client_review': return ok(await core.taskOperations.requestClientReview(auth.actor, id, getEnv().APP_ORIGIN));
    }
  } catch (error) {
    return errorResponse(error);
  }
}
