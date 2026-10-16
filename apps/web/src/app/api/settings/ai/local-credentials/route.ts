import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { listLocalAiCredentials } from '@/lib/local-ai-credentials';
import { errorResponse, ok } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    await getCore().aiSettings.get(auth.actor);
    return ok({ providers: await listLocalAiCredentials() });
  } catch (error) {
    return errorResponse(error);
  }
}
