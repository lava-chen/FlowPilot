import type {
  WhatsAppMessageEvent,
  WhatsAppMessageType,
  WhatsAppStatusEvent,
  WhatsAppWebhookPayload,
} from '@flowpilot/domain';

/**
 * Pulls a single text/image body out of a raw WhatsApp message envelope.
 * We surface only what the inbox needs: the body string, the sender, the timestamp.
 * Other message types (audio, document, video, sticker, location) collapse to a short
 * description so the AI analyzer still sees *something* but never hallucinates content.
 */
export function extractBodyFromMessage(message: {
  type?: string;
  text?: { body?: string };
  image?: { caption?: string; id?: string; mime_type?: string };
}): { type: WhatsAppMessageType; body: string } {
  switch (message.type) {
    case 'text':
      return { type: 'text', body: (message.text?.body ?? '').trim() };
    case 'image': {
      const cap = (message.image?.caption ?? '').trim();
      // No caption means the sender sent a photo without commentary; the AI must ask what
      // it is for rather than guessing.
      return {
        type: 'image',
        body: cap.length > 0 ? cap : '[image: no caption]',
      };
    }
    case 'document':
      return { type: 'document', body: '[document attachment]' };
    case 'audio':
      return { type: 'audio', body: '[audio message]' };
    case 'video':
      return { type: 'video', body: '[video message]' };
    default:
      return { type: 'unknown', body: `[unsupported message type: ${message.type ?? 'unknown'}]` };
  }
}

/**
 * Normalize the top-level Meta webhook payload into a flat list of pure events.
 *
 * Why iterate and flatten rather than keep entry/changes/messages deeply nested: the inbox
 * only cares about *one* inbound message or status update at a time, and the response in the
 * 200 path only needs to confirm "accepted" or "duplicate". Keeping the structure flat lets
 * the webhook controller stream events into the pipeline without rebuilding the tree at every
 * hop, and gives the test layer an obvious input/output contract.
 */
export function normalizeWhatsAppPayload(input: {
  payload: WhatsAppWebhookPayload;
  fallbackReceivedAt?: string;
}): { messages: WhatsAppMessageEvent[]; statuses: WhatsAppStatusEvent[] } {
  const fallback = input.fallbackReceivedAt ?? new Date().toISOString();
  const messages: WhatsAppMessageEvent[] = [];
  const statuses: WhatsAppStatusEvent[] = [];

  for (const entry of input.payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id ?? '';
      const businessAccountId = entry.id ?? null;
      const displayPhoneNumber = value.metadata?.display_phone_number ?? null;

      // Map contacts by `wa_id` so we can attach a friendly name to a message when Meta sends it.
      const contactNames = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c.wa_id) {
          const name = c.profile?.name?.trim();
          if (name) contactNames.set(c.wa_id, name);
        }
      }

      for (const message of value.messages ?? []) {
        if (!message.id || !message.from) continue;
        const { type, body } = extractBodyFromMessage(message);
        messages.push({
          externalId: message.id,
          from: message.from,
          fromName: contactNames.get(message.from) ?? null,
          phoneNumberId,
          type,
          body,
          receivedAt: toIso(message.timestamp) ?? fallback,
          businessAccountId,
          displayPhoneNumber,
        });
      }
      for (const status of value.statuses ?? []) {
        if (!status.id || !status.status) continue;
        const errorEntry = status.errors?.[0];
        statuses.push({
          externalId: status.id,
          status: mapStatusName(status.status),
          recipientId: status.recipient_id ?? '',
          at: toIso(status.timestamp) ?? fallback,
          errorCode: errorEntry?.code != null ? String(errorEntry.code) : null,
          errorTitle: errorEntry?.title ?? null,
        });
      }
    }
  }

  return { messages, statuses };
}

function toIso(value: string | number | undefined): string | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isNaN(n) && n > 1_000_000_000) {
    return new Date(n * 1000).toISOString();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function mapStatusName(raw: string): WhatsAppStatusEvent['status'] {
  switch (raw) {
    case 'sent':
    case 'delivered':
    case 'read':
    case 'failed':
      return raw;
    default:
      // Anything we don't recognize we conservatively map to `sent` so a future Meta flag
      // doesn't silently flip a delivery record to "failed".
      return 'sent';
  }
}
