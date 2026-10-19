import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';
import {
  MockOutlookGraphChannel,
  MockWhatsAppChannel,
  OutlookGraphChannel,
  WhatsAppCloudChannel,
  type ChannelDriver,
} from '@flowpilot/integrations';
import { ValidationError } from '@flowpilot/shared';

export const dynamic = 'force-dynamic';

/**
 * `approved -> sending -> sent | failed`.
 *
 * The channel driver is resolved server-side from the persisted action's `provider` plus the
 * org's stored credentials. The client never supplies a provider or driver.
 *
 * The important rule here: **a misconfigured integration fails loudly, it does not fall back to
 * a mock.** The previous version returned `MockWhatsAppChannel` whenever `accessToken` was
 * missing, which meant an org that had genuinely configured Meta credentials (which were then
 * stripped before storage) got a green "sent" with a fake `externalMessageId` while no message
 * left the building. A demo fallback is only correct when the org was never configured; once
 * configuration exists, sending must either work or raise.
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireActorOr401(_request);
    if ('response' in auth) return auth.response;

    const action = await getCore().outbounds.require(auth.actor, (await ctx.params).id);
    const driver = await resolveChannelForAction(auth.actor.orgId, action.provider);
    const sent = await getCore().outbounds.send(auth.actor, action.id, driver);
    return ok({ action: sent });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Build the channel driver for an outbound action.
 *
 * Each provider gets its own driver, and each decides for itself whether a mock is legitimate:
 * a mock is only used when the org has *no* stored credentials for that provider at all (the
 * offline demo). Once configuration exists we construct the live driver and let it report real
 * failures.
 */
async function resolveChannelForAction(orgId: string, provider: string): Promise<ChannelDriver> {
  switch (provider) {
    case 'whatsapp-cloud':
      return resolveWhatsAppChannel(orgId);
    case 'outlook-graph':
      return resolveOutlookChannel(orgId);
    default:
      throw new ValidationError(`No outbound channel is registered for provider "${provider}".`, {
        field: 'provider',
      });
  }
}

async function resolveWhatsAppChannel(orgId: string): Promise<ChannelDriver> {
  const integrations = getCore().integrations;
  const config = (await integrations.getConnectionConfig(orgId, 'whatsapp-cloud')) ?? {};

  const accessToken = await integrations.readSecret(orgId, 'whatsapp-cloud', 'accessToken');
  const apiBase = String(config['apiBase'] ?? '');
  const phoneNumberId = String(config['phoneNumberId'] ?? '');

  if (!accessToken) {
    // No credential at all -> the org is running the offline demo. That is a legitimate mock.
    // If the operator *did* try to configure this, they'd have a config with no token, which is
    // a half-configured integration; fail rather than pretend.
    if (apiBase || phoneNumberId) {
      throw new ValidationError(
        'WhatsApp is configured but has no access token. Re-save the integration credentials before sending.',
        { provider: 'whatsapp-cloud' },
      );
    }
    return new MockWhatsAppChannel();
  }

  if (!apiBase || !phoneNumberId) {
    throw new ValidationError('WhatsApp has an access token but is missing apiBase or phoneNumberId.', {
      provider: 'whatsapp-cloud',
    });
  }

  return new WhatsAppCloudChannel({
    apiBase,
    accessToken,
    phoneNumberId,
    businessAccountId: String(config['businessAccountId'] ?? ''),
  });
}

async function resolveOutlookChannel(orgId: string): Promise<ChannelDriver> {
  const core = getCore();
  const status = await core.integrations.getConnectionStatus(orgId, 'outlook-graph');

  if (status !== 'connected') {
    // Not connected -> offline demo path. Same rule as WhatsApp: only when unconfigured.
    return new MockOutlookGraphChannel();
  }

  const config = (await core.integrations.getConnectionConfig(orgId, 'outlook-graph')) ?? {};
  const graphBase = String(config['graphBase'] ?? '') || undefined;

  // The OAuth service owns token refresh; the driver asks it for a token at send time rather
  // than holding one, so an expired access token is refreshed instead of failing the send.
  return new OutlookGraphChannel({
    ...(graphBase ? { graphBase } : {}),
    tokenProvider: {
      getAccessToken: async () => {
        const token = await core.oauth.getAccessToken(systemActorFor(orgId), 'outlook-graph');
        if (!token) {
          throw new ValidationError('Outlook is connected but no access token is available.', {
            provider: 'outlook-graph',
          });
        }
        return token;
      },
    },
  });
}

function systemActorFor(orgId: string) {
  return { kind: 'system' as const, orgId, label: 'Outbound dispatcher' };
}
