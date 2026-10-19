import type {
  IngestionOutcome,
  IntegrationAdapter,
} from './adapter.js';
import type { NormalizedInboundMessage } from '@flowpilot/core';

/**
 * Outlook integration adapter.
 *
 * Mail is push from our side (Graph delta) — Microsoft does not currently open a webhook
 * for free tenants in a way FlowPilot can secure. So `poll` is intentionally a no-op; the
 * sync cadence lives in the dashboard "Sync now" button (and Phase 4's scheduler).
 *
 * What this adapter still has to do:
 *   - `verifyWebhook` — always returns false because Outlook has no FlowPilot-controlled
 *     webhook; the assertion is a defense against a future provider attempting a webhook
 *     handshake against the same route.
 *   - `normalize` — pass-through so the unified pipeline can ingest a normalized message
 *     from the sync service.
 */
export class OutlookAdapter implements IntegrationAdapter {
  readonly provider = 'outlook-graph';
  readonly displayName = 'Microsoft Outlook';
  readonly simulateInUi = false;

  async poll(): Promise<IngestionOutcome> {
    return { accepted: [], duplicates: [], drafts: [], runIds: [] };
  }

  normalize(payload: NormalizedInboundMessage): NormalizedInboundMessage {
    return {
      provider: this.provider,
      externalId: payload.externalId,
      from: payload.from,
      fromName: payload.fromName,
      subject: payload.subject ?? '(no subject)',
      body: payload.body.replace(/\r\n/g, '\n').trim(),
      receivedAt: payload.receivedAt ?? new Date().toISOString(),
    };
  }

  verifyWebhook?(_headers: Record<string, string | undefined>, _rawBody: string): boolean {
    // Outlook Graph change notifications *can* arrive via webhooks, but validating
    // them requires a subscription + clientState handshake that the dashboard
    // walks through the OAuth flow. Phase 2 stops at delta-query polling; we leave
    // this hook as a hard false to surface configuration mistakes loudly.
    return false;
  }
}
