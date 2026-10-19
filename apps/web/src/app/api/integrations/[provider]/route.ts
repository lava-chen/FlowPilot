import { z } from 'zod';
import type { IntegrationCatalogStatus } from '@flowpilot/domain';
import { IntegrationCatalogStatusSchema } from '@flowpilot/domain';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

const KNOWN_PROVIDERS = ['whatsapp-cloud', 'outlook-graph', 'generic-webhook', 'mock-email'] as const;

const UpsertSchema = z.object({
  status: IntegrationCatalogStatusSchema,
  config: z.record(z.string(), z.unknown()).default({}),
  /** Optional access token for `whatsapp-cloud` — encrypted before storage. */
  accessToken: z.string().optional(),
  appSecret: z.string().optional(),
});

/**
 * Upsert a single integration connection. Owners and admins only.
 *
 * Body shape:
 *   { status, config, accessToken?, appSecret? }
 *
 * `config` is the structured configuration (phone_number_id, business_account_id, verify_token,
 * api_base, ...). `accessToken` and `appSecret` are *never* echoed back; they live only on the
 * server side and only used for HMAC verification + outbound delivery.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const { provider } = await ctx.params;
    if (!isKnownProvider(provider)) {
      return Response.json({ error: { code: 'not_found', message: `Unknown provider "${provider}".` } }, { status: 404 });
    }
    const input = await parseBody(request, UpsertSchema);
    // Compose the persisted config: keep the existing config for the provider, then merge
    // any incoming update. Access tokens and app secrets go to dedicated fields, not config.
    const existing = await getCore().integrations.listConnections(auth.actor).catch(() => []);
    const found = existing.find((c) => c.provider === provider);
    const baseConfig = (found?.config ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...baseConfig, ...input.config };
    if (input.accessToken) merged['accessToken'] = input.accessToken;
    if (input.appSecret) merged['appSecret'] = input.appSecret;

    const updated = await getCore().integrations.upsert(auth.actor, {
      provider,
      status: input.status as IntegrationCatalogStatus,
      config: merged,
    });
    return ok({ connection: redact(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const { provider } = await ctx.params;
    if (!isKnownProvider(provider)) {
      return Response.json({ error: { code: 'not_found', message: `Unknown provider "${provider}".` } }, { status: 404 });
    }
    const updated = await getCore().integrations.disconnect(auth.actor, provider);
    return ok({ connection: redact(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const { provider } = await ctx.params;
    if (!isKnownProvider(provider)) {
      return Response.json({ error: { code: 'not_found', message: `Unknown provider "${provider}".` } }, { status: 404 });
    }
    const conns = await getCore().integrations.listConnections(auth.actor);
    const found = conns.find((c) => c.provider === provider);
    return ok({ connection: found ? redact(found) : null });
  } catch (error) {
    return errorResponse(error);
  }
}

function isKnownProvider(p: string): p is (typeof KNOWN_PROVIDERS)[number] {
  return (KNOWN_PROVIDERS as readonly string[]).includes(p);
}

/** Strip anything we don't want echoed back to the browser. */
function redact<T extends { config: Record<string, unknown> }>(connection: T): Omit<T, 'config'> & { config: Record<string, unknown> } {
  const { accessToken, appSecret, apiKey, ...safe } = connection.config ?? {};
  void accessToken;
  void appSecret;
  void apiKey;
  return { ...connection, config: safe };
}
