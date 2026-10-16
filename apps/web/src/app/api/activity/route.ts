import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 40);
    const core = getCore();
    return ok(await core.queries.activity(auth.actor, Number.isFinite(limit) ? limit : 40));
  } catch (error) {
    return errorResponse(error);
  }
}
