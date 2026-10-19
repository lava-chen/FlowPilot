import type { IntegrationConnection } from '@flowpilot/domain';
import { getDb } from '@/lib/runtime';
import { AppError } from '@flowpilot/shared';

/**
 * Webhook-only helper: looks up the org by slug + its `whatsapp-cloud` integration connection.
 *
 * Lives in the web app rather than core because:
 *   - The webhook URL is public — we never want to require a session cookie.
 *   - The system actor is constructed here from `conn.orgId` so signature checks happen before
 *     any business logic runs.
 *
 * Returns `null` when the org slug is unknown or no WhatsApp connection is configured. The
 * controller turns `null` into 404 so mis-subscribed webhooks fail loudly.
 */
export async function resolveConnectionForWebhook(orgSlug: string): Promise<IntegrationConnection | null> {
  if (!orgSlug || typeof orgSlug !== 'string') return null;
  const db = getDb();
  const org = await db.repos.organizations.findBySlug(orgSlug);
  if (!org) return null;
  const conns = await db.repos.integrations.list(org.id);
  return conns.find((c) => c.provider === 'whatsapp-cloud') ?? null;
}

export class WhatsAppSignatureError extends AppError {
  constructor(message: string) {
    super('integration_error', message, { status: 401 });
  }
}

export class WhatsAppPayloadError extends AppError {
  constructor(message: string) {
    super('validation_failed', message, { status: 400 });
  }
}
