import { NextRequest } from 'next/server';
import {
  WhatsAppWebhookPayloadSchema,
  type WhatsAppWebhookPayload,
} from '@flowpilot/domain';
import {
  handleWhatsAppEvents,
  normalizeWhatsAppPayload,
  verifyWhatsAppHandshake,
  verifyWhatsAppSignature,
} from '@flowpilot/integrations';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok } from '@/lib/http';
import {
  WhatsAppSignatureError,
  WhatsAppPayloadError,
  resolveConnectionForWebhook,
} from '@/lib/webhooks/whatsapp-helpers';

export const dynamic = 'force-dynamic';

/**
 * WhatsApp Cloud API webhook.
 *
 * Two flows share this URL:
 *
 *   GET  — Meta's subscription handshake.
 *          ?hub.mode=subscribe&hub.verify_token=<expected>&hub.challenge=<echo>
 *
 *   POST — Real events (messages and statuses). Verifies the HMAC-SHA256 signature header
 *          (`X-Hub-Signature-256: sha256=...`) against the raw body, parses the payload, and
 *          hands events to the unified pipeline.
 *
 * The route is parameterized by `orgSlug` so Meta can subscribe to one URL per tenant. The
 * App Secret is read from that org's stored `integration_connections.config` — never from the
 * URL or a global env var.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ orgSlug: string }> },
): Promise<Response> {
  try {
    const { orgSlug } = await ctx.params;
    if (!orgSlug) {
      return errorResponse(new WhatsAppPayloadError('Webhook URL missing org slug.'));
    }
    const conn = await resolveConnectionForWebhook(orgSlug);
    if (!conn) {
      return new Response('Webhook not configured for this org.', { status: 404 });
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const verifyToken = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const expected = String(conn.config['verifyToken'] ?? '');
    if (!verifyWhatsAppHandshake({ expectedVerifyToken: expected, mode, verifyToken })) {
      return new Response('Verification failed.', { status: 403 });
    }
    return new Response(challenge ?? '', { status: 200, headers: { 'content-type': 'text/plain' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ orgSlug: string }> },
): Promise<Response> {
  try {
    const { orgSlug } = await ctx.params;
    if (!orgSlug) {
      return errorResponse(new WhatsAppPayloadError('Webhook URL missing org slug.'));
    }
    const conn = await resolveConnectionForWebhook(orgSlug);
    if (!conn) {
      return new Response('Webhook not configured for this org.', { status: 404 });
    }
    // The app secret is encrypted at rest and only ever decrypted here, after the org has been
    // resolved from the webhook URL. It is never read from `conn.config` (which carries only
    // non-secret settings) and never accepted from the request.
    const appSecret = await getCore().integrations.readSecret(conn.orgId, 'whatsapp-cloud', 'appSecret');
    if (!appSecret) {
      return errorResponse(new WhatsAppSignatureError('WhatsApp app secret missing for this org.'));
    }

    // Read raw body, NOT request.json(), because the HMAC is over the bytes Meta sent.
    const rawBody = await request.text();
    const sig = request.headers.get('x-hub-signature-256');
    if (!verifyWhatsAppSignature({ appSecret, signatureHeader: sig, rawBody })) {
      return errorResponse(new WhatsAppSignatureError('Invalid signature.'));
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return errorResponse(new WhatsAppPayloadError('Body is not valid JSON.'));
    }
    const parsed = WhatsAppWebhookPayloadSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return errorResponse(new WhatsAppPayloadError('Payload did not match the WhatsApp envelope.'));
    }
    const events = normalizeWhatsAppPayload({ payload: parsed.data as WhatsAppWebhookPayload });

    // Webhook ingestion is system-driven; orgId comes from the resolved connection.
    const actor = {
      kind: 'system' as const,
      orgId: conn.orgId,
      label: `WhatsApp webhook (${orgSlug})`,
    };
    const result = await handleWhatsAppEvents({
      core: getCore(),
      // `system` actors pass through `assertCan` via the system branch; cast for service signature.
      actor: actor as never,
      events,
    });

    return ok({ ingested: result.ingested.length, statuses: result.statuses.length });
  } catch (error) {
    return errorResponse(error);
  }
}
