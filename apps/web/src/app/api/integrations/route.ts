import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Lists every integration known to this tenant (WhatsApp, Outlook, Generic Webhook, Mock),
 * with the live catalog state. The dashboard renders this as a tile list.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const catalog = await getCore().integrations.catalog(auth.actor);
    return ok({ integrations: catalog });
  } catch (error) {
    return errorResponse(error);
  }
}
