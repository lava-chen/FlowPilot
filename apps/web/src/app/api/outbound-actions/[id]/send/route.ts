import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';
import {
  MockWhatsAppChannel,
  WhatsAppCloudChannel,
  type ChannelDriver,
} from '@flowpilot/integrations';

export const dynamic = 'force-dynamic';

/**
 * `approved -> sending -> sent | failed`.
 *
 * The route picks the channel driver that matches the action's `provider`. In test /
 * offline mode (no `accessToken` in the org's WhatsApp connection) we always run the mock
 * driver so the demo can exercise the full lifecycle without external services.
 *
 * This route never accepts `provider` or `driver` from the client — the channel is fully
 * determined server-side from the persisted action + org config.
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireActorOr401(_request);
    if ('response' in auth) return auth.response;

    const action = await getCore().outbounds.require(auth.actor, (await ctx.params).id);
    const driver = await resolveChannelForAction(auth.actor.orgId, action.provider, getCore().db);
    const sent = await getCore().outbounds.send(auth.actor, action.id, driver);
    return ok({ action: sent });
  } catch (error) {
    return errorResponse(error);
  }
}

async function resolveChannelForAction(
  orgId: string,
  provider: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<ChannelDriver> {
  if (provider !== 'whatsapp-cloud') {
    return new MockWhatsAppChannel();
  }
  const conns = await db.repos.integrations.list(orgId);
  const conn = conns.find((c: { provider: string }) => c.provider === 'whatsapp-cloud');
  const config = (conn?.config ?? {}) as Record<string, unknown>;
  const accessToken = String(config['accessToken'] ?? '');
  const apiBase = String(config['apiBase'] ?? '');
  const phoneNumberId = String(config['phoneNumberId'] ?? '');
  if (!accessToken || !apiBase || !phoneNumberId) {
    return new MockWhatsAppChannel();
  }
  return new WhatsAppCloudChannel({
    apiBase,
    accessToken,
    phoneNumberId,
    businessAccountId: String(config['businessAccountId'] ?? ''),
  });
}
