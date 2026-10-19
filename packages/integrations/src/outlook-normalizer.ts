import type { NormalizedInboundMessage } from '@flowpilot/core';
import type { OutlookMessageEvent } from '@flowpilot/domain';

/**
 * The Microsoft Graph message envelope (subset). We declare this here rather than
 * pulling it from `@flowpilot/domain` because the integration package is the layer
 * that talks to third-party APIs; `domain` only sees the *normalized* event.
 *
 * Reference:
 *   https://learn.microsoft.com/en-us/graph/api/resources/message
 */
export interface OutlookGraphMessage {
  id: string;
  subject?: string | null;
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  from?: { emailAddress?: { name?: string | null; address?: string | null } } | null;
  toRecipients?: Array<{ emailAddress?: { name?: string | null; address?: string | null } }>;
  body?: { contentType?: 'Text' | 'HTML'; content?: string } | null;
  bodyPreview?: string;
  isDraft?: boolean;
  '@odata.etag'?: string;
  parentFolderId?: string;
  conversationId?: string;
}

const HTML_TAG = /<[^>]+>/g;

/**
 * Pull a plain-text body. We prefer `body.contentType === 'Text'` to keep things
 * simple; for HTML bodies we strip tags but leave quoted-printable / quoted
 * reply lines intact. Reply chains collapse to a single block at the bottom.
 */
function bodyText(message: OutlookGraphMessage): string {
  const body = message.body ?? null;
  if (!body) return message.bodyPreview ?? '';
  if (body.contentType === 'Text') return body.content ?? '';
  // HTML — strip but keep newlines between block-level tags.
  const html = body.content ?? '';
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(HTML_TAG, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function folderFromParent(parentFolderId?: string): 'inbox' | 'junkemail' | 'other' {
  if (!parentFolderId) return 'other';
  if (parentFolderId.toLowerCase().includes('junk')) return 'junkemail';
  if (parentFolderId.toLowerCase().includes('inbox')) return 'inbox';
  return 'other';
}

/**
 * Turn a single Graph message into a domain-level `OutlookMessageEvent`.
 *
 * Filtering for junk / drafts / BCC-only senders happens at the caller — the
 * normalizer is pure shape mapping so tests can pin each branch.
 */
export function normalizeOutlookMessage(message: OutlookGraphMessage): OutlookMessageEvent | null {
  if (!message.id) return null;
  const from = message.from?.emailAddress?.address?.trim();
  if (!from) return null;
  const to = (message.toRecipients ?? [])
    .map((r) => r.emailAddress?.address ?? '')
    .filter((a) => a.length > 0);

  return {
    externalId: message.id,
    from,
    fromName: message.from?.emailAddress?.name?.trim() || null,
    to,
    subject: (message.subject ?? '(no subject)').trim(),
    body: bodyText(message),
    receivedAt:
      message.receivedDateTime ??
      message.sentDateTime ??
      new Date().toISOString(),
    folder: folderFromParent(message.parentFolderId),
    directlyAddressed: to.length > 0,
    changeKey: message['@odata.etag'] ?? null,
  };
}

export function normalizeOutlookMessages(messages: OutlookGraphMessage[]): { messages: OutlookMessageEvent[] } {
  const events: OutlookMessageEvent[] = [];
  for (const m of messages) {
    const evt = normalizeOutlookMessage(m);
    if (evt) events.push(evt);
  }
  return { messages: events };
}

/** Domain <-> Graph glue: turn an `OutlookMessageEvent` into a `NormalizedInboundMessage`. */
export function outlookEventToNormalized(
  provider: string,
  event: OutlookMessageEvent,
): NormalizedInboundMessage {
  const sender = event.fromName ? `${event.fromName} <${event.from}>` : event.from;
  return {
    provider,
    externalId: event.externalId,
    from: sender,
    fromName: event.fromName ?? undefined,
    subject: event.subject,
    body: event.body,
    receivedAt: event.receivedAt,
  };
}
