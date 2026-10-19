import type {
  Actor,
  WhatsAppMessageEvent,
  WhatsAppStatusEvent,
} from '@flowpilot/domain';
import type {
  NormalizedInboundMessage,
} from '@flowpilot/core';
import type {
  IntegrationAdapter,
  IngestionOutcome,
} from './adapter.js';
import { ingestAndDraft } from './adapter.js';
import type { CoreServices } from '@flowpilot/core';
import { verifyWhatsAppSignature, verifyWhatsAppHandshake } from './signature.js';
import {
  normalizeWhatsAppPayload,
} from './whatsapp-normalizer.js';
import type { ChannelDriver } from './whatsapp-channel.js';

/**
 * WhatsApp Cloud API integration adapter.
 *
 * Two paths:
 *   - `verifyWebhook`     — pure signature & handshake checks. Stateless, no DB.
 *   - `handleWebhookBody` — full ingest pipeline. Called by the webhook controller after
 *                            the request passes signature verification.
 *
 * The adapter does **not** send messages by itself. Sends are driven through `ChannelDriver`
 * by `OutboundActionService`; the adapter only knows the inbound side and the connection
 * configuration used to instantiate a real `WhatsAppCloudChannel` for sending.
 */
export interface WhatsAppAdapterOptions {
  /** Override the channel driver used for *inbound* UI simulations; defaults to Mock. */
  simulateChannel?: ChannelDriver;
  /** Channel driver factory that reads an integration connection's `config` blob. */
  buildChannelFromConnection?: (conn: {
    provider: string;
    status: string;
    config: Record<string, unknown>;
  }) => ChannelDriver | null;
}

export class WhatsAppAdapter implements IntegrationAdapter {
  readonly provider: string;
  readonly displayName: string;
  readonly simulateInUi: boolean;

  constructor(
    _options: WhatsAppAdapterOptions = {},
    providerId: string = 'whatsapp-cloud',
  ) {
    this.provider = providerId;
    this.displayName = 'WhatsApp Business';
    this.simulateInUi = false; // Real providers don't have canned templates; the demo template
                                 // for WhatsApp lives behind an opt-in "Retail bakery demo".
  }

  /** No polling: WhatsApp is push-based (webhooks). */
  async poll(): Promise<IngestionOutcome> {
    return { accepted: [], duplicates: [], drafts: [], runIds: [] };
  }

  /** Pure normalizer used by tests and by the webhook controller. */
  normalize(payload: NormalizedInboundMessage): NormalizedInboundMessage {
    return {
      provider: this.provider,
      externalId: payload.externalId,
      from: payload.from,
      fromName: payload.fromName,
      subject: payload.subject ?? payload.subject ?? '(no subject)',
      body: payload.body.replace(/\r\n/g, '\n').trim(),
      receivedAt: payload.receivedAt ?? new Date().toISOString(),
    };
  }

  verifyWebhook?(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): boolean;

  /**
   * Helper exported for tests and the webhook controller: turn a raw Meta payload into
   * typed events *without* an external dependency on the runtime.
   */
  static normalizePayload = normalizeWhatsAppPayload;
}

export interface HandleWhatsAppEventsOptions {
  core: CoreServices;
  actor: Actor;                       // System actor — webhook ingestion is system-driven.
  events: WhatsAppMessageEvent[] | { messages: WhatsAppMessageEvent[]; statuses: WhatsAppStatusEvent[] };
  /** Mock-only knobs used by the dashboard "simulate inbound WhatsApp" demo button. */
  simulate?: boolean;
}

export interface HandleWhatsAppEventsResult {
  ingested: Array<{ externalId: string; requestId: string; deduplicated: boolean; runId: string | null }>;
  statuses: Array<{ externalId: string; actionId: string | null; status: WhatsAppStatusEvent['status']; errorMessage: string | null }>;
}

/**
 * Drives a list of normalized events through the existing pipeline:
 *   inbound messages -> dedupe + Request + (optional) Task draft
 *   status events    -> update OutboundAction row when external_message_id matches
 *
 * Reuses `ingestAndDraft` from the package so the audit trail and run history are identical
 * to the mock-email path. This is the seam the WhatsApp demo competes on: not a special-case
 * pipeline, just another channel on the same core.
 */
export async function handleWhatsAppEvents(
  opts: HandleWhatsAppEventsOptions,
): Promise<HandleWhatsAppEventsResult> {
  const { core, actor } = opts;
  const events = Array.isArray(opts.events)
    ? { messages: opts.events, statuses: [] as WhatsAppStatusEvent[] }
    : opts.events;

  const ingested: HandleWhatsAppEventsResult['ingested'] = [];
  const statuses: HandleWhatsAppEventsResult['statuses'] = [];

  // Build a one-off adapter that shares the package-level `verifyWhatsAppSignature` and
  // routing so the controller treats this as a regular integration.
  const adapter = new WhatsAppAdapter({});
  // We pass the original Meta envelope shape through; `ingestAndDraft` only uses
  // `normalize()` on `NormalizedInboundMessage`, which is what we constructed above.
  for (const event of events.messages) {
    const message: NormalizedInboundMessage = {
      provider: adapter.provider,
      externalId: event.externalId,
      from: event.from,
      fromName: event.fromName ?? undefined,
      subject: `WhatsApp message`,
      body: event.body,
      receivedAt: event.receivedAt,
    };
    const result = await ingestAndDraft(core, actor, adapter, message, { createDraft: true });
    ingested.push({
      externalId: event.externalId,
      requestId: result.request.id,
      deduplicated: result.deduplicated,
      runId: result.runId,
    });
  }

  // Status updates are *not* audits — they update rows. The channel's webhook must arrive
  // before/after the canonical send; we cannot assume ordering, so the lookup is by the
  // provider's external message id.
  for (const s of events.statuses) {
    const action = await core.db.repos.outboundActions.findByExternalMessageId(actor.orgId, s.externalId);
    if (!action) {
      // A status for a message we don't know about is not an error: the system may have
      // restarted. Surface it in the activity log and move on.
      statuses.push({ externalId: s.externalId, actionId: null, status: s.status, errorMessage: null });
      continue;
    }
    let nextStatus: 'sent' | 'failed' | null = null;
    if (s.status === 'sent' || s.status === 'delivered' || s.status === 'read') nextStatus = 'sent';
    else if (s.status === 'failed') nextStatus = 'failed';
    if (nextStatus && (action.status === 'sending' || action.status === 'approved')) {
      const updated = await core.db.repos.outboundActions.updateStatus(action.orgId, action.id, nextStatus, {
        externalMessageId: action.externalMessageId ?? s.externalId,
        errorMessage: nextStatus === 'failed' ? `${s.errorTitle ?? 'Failed'}: ${s.errorCode ?? ''}` : null,
        sentAt: nextStatus === 'sent' ? s.at : undefined,
      });
      await core.db.repos.outboundActions.recordEvent({
        id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        orgId: action.orgId,
        actionId: action.id,
        fromStatus: action.status,
        toStatus: nextStatus,
        actorKind: 'system',
        actorId: 'system',
        actorLabel: 'WhatsApp webhook',
        errorCode: s.errorCode ?? undefined,
        errorTitle: s.errorTitle ?? undefined,
      });
      statuses.push({ externalId: s.externalId, actionId: updated.id, status: s.status, errorMessage: updated.errorMessage });
    } else {
      statuses.push({ externalId: s.externalId, actionId: action.id, status: s.status, errorMessage: null });
    }
  }

  return { ingested, statuses };
}

/**
 * Re-exported pure helpers so the webhook controller can import everything it needs from one
 * file. Keeps the public surface intentional: tests do not need to know which sub-file holds
 * the verifier.
 */
export { verifyWhatsAppSignature, verifyWhatsAppHandshake };
