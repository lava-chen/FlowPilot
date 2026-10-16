import { TaskListQuerySchema } from '@flowpilot/domain';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const url = new URL(request.url);
    const parsed = TaskListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    const query = parsed.success ? parsed.data : { limit: 100 };

    const core = getCore();
    const board = await core.queries.taskBoard(auth.actor, {
      assigneeId: query.assigneeId,
      projectId: query.projectId,
    });

    return ok({
      ...board,
      tasks: board.tasks
        .filter((task) => (query.status ? query.status.includes(task.status) : true))
        .slice(0, query.limit),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
