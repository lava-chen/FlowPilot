import { RequestListQuerySchema, type RequestStatus } from '@flowpilot/domain';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const url = new URL(request.url);
    const parsed = RequestListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    const query = parsed.success ? parsed.data : { limit: 50 };
    // `?status=a&status=b` should filter too, not just `?status=a,b`.
    const statuses = (query.status ? (Array.isArray(query.status) ? query.status : [query.status]) : undefined) as
      | RequestStatus[]
      | undefined;

    const core = getCore();
    const inbox = await core.queries.inbox(auth.actor, {
      status: statuses,
      limit: query.limit,
    });

    return ok(inbox);
  } catch (error) {
    return errorResponse(error);
  }
}
