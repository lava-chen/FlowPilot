import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const core = getCore();
    return ok(await core.queries.overview(auth.actor));
  } catch (error) {
    return errorResponse(error);
  }
}
