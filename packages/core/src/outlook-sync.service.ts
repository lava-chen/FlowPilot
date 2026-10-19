import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor } from '@flowpilot/domain';
import type { NormalizedInboundMessage } from './ingestion.service.js';
import {
  ForbiddenError,
  IntegrationError,
  ValidationError,
} from '@flowpilot/shared';
import { assertCan } from './permissions.js';
import type { AuditService } from './audit.service.js';
import {
  OUTLOOK_DEFAULT_SCOPES,
  type OAuthService,
  type OutlookProviderConfig,
} from './outlook-oauth.service.js';
import type { OutlookMessageEvent } from '@flowpilot/domain';
import { IngestionService } from './ingestion.service.js';
import { WorkflowService } from './workflow.service.js';
import type { OutboundActionService } from './outbound-action.service.js';

/**
 * Outlook (Microsoft Graph) delta-query mailbox sync.
 *
 * One service, two paths:
 *   - `syncOnce(org, provider)` — does one delta round trip. Idempotent.
 *   - Run from the dashboard's "Sync now" button OR a scheduled job (Phase 4 will
 *     add a real scheduler; for now the dashboard button is enough).
 *
 * Why a separate service rather than the WhatsApp adapter: Graph delta is *stateful*
 * (it carries a skip-token in the URL) and *bidirectional* (we send replies through
 * the same OAuth identity). The WhatsApp adapter is push-only.
 */
export interface OutlookSyncDeps {
  db: FlowPilotDb;
  audit: AuditService;
  oauth: OAuthService;
  /**
   * Used to draft the reply. Optional so the sync can run in contexts that only care about
   * ingestion (tests, the connect-check flow); when absent, sync still populates the inbox and
   * simply reports `drafts: 0`.
   */
  outbounds?: OutboundActionService;
  /** Optional provider config; when absent we fall back to Graph's public endpoint. */
  graphProvider?: OutlookProviderConfig;
}

export interface OutlookSyncResult {
  fetched: number;
  ingested: number;
  duplicates: number;
  drafts: number;
  cursorStored: boolean;
  durationMs: number;
  errors: Array<{ externalId: string; error: string }>;
}

interface OutlookGraphEnvelope {
  value?: OutlookGraphMessageRaw[];
  '@odata.deltaLink'?: string;
  '@odata.nextLink'?: string;
}

interface OutlookGraphMessageRaw {
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

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGES_PER_RUN = 5;
const HTML_TAG = /<[^>]+>/g;

function stripHtml(input: string | null | undefined): string {
  if (!input) return '';
  return input
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

function bodyText(message: OutlookGraphMessageRaw): string {
  const body = message.body ?? null;
  if (!body) return message.bodyPreview ?? '';
  if (body.contentType === 'Text') return body.content ?? '';
  return stripHtml(body.content ?? '');
}

function folderFromParent(parentFolderId?: string): 'inbox' | 'junkemail' | 'other' {
  if (!parentFolderId) return 'other';
  if (parentFolderId.toLowerCase().includes('junk')) return 'junkemail';
  if (parentFolderId.toLowerCase().includes('inbox')) return 'inbox';
  return 'other';
}

function rawToOutlookEvent(message: OutlookGraphMessageRaw): OutlookMessageEvent | null {
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

function eventToNormalized(provider: string, evt: OutlookMessageEvent): NormalizedInboundMessage {
  const sender = evt.fromName ? `${evt.fromName} <${evt.from}>` : evt.from;
  return {
    provider,
    externalId: evt.externalId,
    from: sender,
    fromName: evt.fromName ?? undefined,
    subject: evt.subject,
    body: evt.body,
    receivedAt: evt.receivedAt,
  };
}

export class OutlookSyncService {
  constructor(private readonly deps: OutlookSyncDeps) {}

  /**
   * Run one delta-query round. Returns a count summary; callers decide whether
   * to run again (e.g. if `cursorStored && ingested >= MAX_PAGES_PER_RUN * PAGE_SIZE`).
   */
  async syncOnce(
    actor: Actor,
    options: {
      provider?: string;
      pageSize?: number;
      maxPages?: number;
      folder?: 'inbox' | 'junkemail';
      fetchImpl?: typeof fetch;
    } = {},
  ): Promise<OutlookSyncResult> {
    assertCan(actor, 'integrations:manage');
    const startTime = Date.now();
    const provider = options.provider ?? 'outlook-graph';
    const folder = options.folder ?? 'inbox';
    const accessToken = await this.deps.oauth.getAccessToken(actor, provider);

    const cursor = await this.deps.db.repos.syncCursors.get(actor.orgId, provider, 'mail-delta');
    const initialUrl = cursor?.cursorValue ?? this.buildListUrl(folder, options.pageSize ?? DEFAULT_PAGE_SIZE);

    const errors: OutlookSyncResult['errors'] = [];
    let nextUrl: string | null = initialUrl;
    let ingested = 0;
    let duplicates = 0;
    let drafts = 0;
    let cursorStored = false;
    let pages = 0;

    const fetchImpl = options.fetchImpl ?? fetch;
    const sysActor: Actor = {
      kind: 'system',
      orgId: actor.orgId,
      label: 'Outlook sync',
    };

    while (nextUrl && pages < (options.maxPages ?? MAX_PAGES_PER_RUN)) {
      const response = await fetchGraph(fetchImpl, nextUrl, accessToken);
      const nextDeltaLink = response['@odata.deltaLink'];
      const nextSkipToken = response['@odata.nextLink'];

      const rawMessages = (response.value ?? []) as OutlookGraphMessageRaw[];
      const ingestion = this.deps.db.repos.requests;
      const workflowsFor = () => new WorkflowService(this.deps.db, actor.orgId);
      const ingestionSvc = new IngestionService(this.deps.db, workflowsFor, this.deps.audit);

      for (const raw of rawMessages) {
        const evt = rawToOutlookEvent(raw);
        if (!evt || evt.folder !== folder) continue;
        try {
          // Check dedupe before ingest so we don't double-write workflow_runs.
          const sourceRef = `${provider}:${evt.externalId}`;
          const existing = await ingestion.findByExternalId(actor.orgId, sourceRef, evt.externalId);
          if (existing) {
            duplicates += 1;
            ingested += 1;
            continue;
          }
          const ingestResult = await ingestionSvc.ingest(sysActor, eventToNormalized(provider, evt));
          ingested += 1;
          // Draft creation is a follow-up; never fail the sync on it.
          if (await this.tryCreateDraft(actor, ingestResult.request.id, evt)) drafts += 1;
        } catch (err) {
          errors.push({ externalId: raw.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      pages += 1;

      if (nextDeltaLink) {
        await this.deps.db.repos.syncCursors.upsert({
          orgId: actor.orgId,
          provider,
          cursorKind: 'mail-delta',
          cursorValue: nextDeltaLink,
          totalIngested: 0,
          lastSyncedAt: new Date().toISOString(),
          metadata: { folder, lastFetched: rawMessages.length, pagesThisRun: pages },
        });
        cursorStored = true;
        nextUrl = null;
      } else if (nextSkipToken) {
        nextUrl = nextSkipToken;
      } else {
        nextUrl = null;
      }
    }

    await this.deps.audit.record(actor, 'integration.outlook_synced', 'integration_connection', provider, {
      provider,
      folder,
      pages,
      ingested,
      duplicates,
      drafts,
      errors: errors.length,
    });

    return {
      fetched: ingested + duplicates,
      ingested,
      duplicates,
      drafts,
      cursorStored,
      durationMs: Date.now() - startTime,
      errors,
    };
  }

  /** Convenience wrapper used by the dashboard "Sync now" button. */
  async syncInboxNow(actor: Actor): Promise<OutlookSyncResult> {
    return this.syncOnce(actor, { folder: 'inbox' });
  }

  /** Force a full re-sync by clearing the cursor. */
  async resetCursor(actor: Actor, provider = 'outlook-graph'): Promise<void> {
    assertCan(actor, 'integrations:manage');
    if (actor.kind !== 'user') {
      throw new ForbiddenError('Resetting the sync cursor requires a human user.', {
        capability: 'integrations:manage',
      });
    }
    await this.deps.db.repos.syncCursors.delete(actor.orgId, provider, 'mail-delta');
    await this.deps.audit.record(actor, 'integration.outlook_sync_reset', 'integration_connection', provider, {
      provider,
    });
  }

  /** Returns the cached cursor meta so the dashboard can show progress. */
  async getCursor(actor: Actor, provider = 'outlook-graph') {
    assertCan(actor, 'integrations:read');
    const cursor = await this.deps.db.repos.syncCursors.get(actor.orgId, provider, 'mail-delta');
    return cursor;
  }

  /**
   * Draft a reply for a freshly ingested Outlook message.
   *
   * Creates the outbound action in `draft` and nothing further — a human still has to submit and
   * approve it before anything is sent, which is the whole point of routing mail through the same
   * approval gate as WhatsApp. The draft itself is safe to create automatically because it has
   * no external effect.
   *
   * Why this used to be a stub: it originally returned `false` unconditionally because the sync
   * service had no dependency on `OutboundActionService` and importing it risked a cycle. The
   * dependency is injected instead, so the layering rule (core never imports the web app's
   * channel wiring) still holds.
   *
   * Failures are swallowed by the caller's try/catch: a missing draft must not fail the sync.
   */
  private async tryCreateDraft(actor: Actor, requestId: string, evt: OutlookMessageEvent): Promise<boolean> {
    const outbounds = this.deps.outbounds;
    if (!outbounds) return false;

    // No recipient address on the thread means there is nowhere to reply; skip rather than
    // create an action that can never be sent.
    const replyTo = evt.from.trim();
    if (!replyTo) return false;

    const request = await this.deps.db.repos.requests.findById(actor.orgId, requestId);
    if (!request) return false;

    // Deterministic per (message, recipient) so a re-sync that re-ingests the same message
    // returns the existing draft instead of creating a second one. Mirrors the WhatsApp
    // generator's `whatsapp:reply:<externalId>` convention.
    const dedupeKey = `outlook-graph:reply:${evt.externalId}`;

    await outbounds.createDraft(actor, {
      channel: 'email',
      provider: 'outlook-graph',
      to: replyTo,
      subject: evt.subject ? `Re: ${evt.subject.replace(/^re:\s*/i, '')}` : 'Re: your message',
      body: buildAcknowledgement(evt),
      requestId,
      dedupeKey,
    });
    return true;
  }

  private buildListUrl(folder: 'inbox' | 'junkemail', pageSize: number): string {
    const cfg = this.deps.graphProvider;
    const base = cfg?.graphBase ?? 'https://graph.microsoft.com/v1.0';
    return `${base}/me/mailFolders/${folder}/messages/delta?$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,sentDateTime&$top=${pageSize}`;
  }
}

async function fetchGraph(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
): Promise<OutlookGraphEnvelope> {
  const resp = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      consistencylevel: 'eventual',
    },
    signal: AbortSignal.timeout(20_000),
  }).catch((err) => {
    throw new IntegrationError(`Microsoft Graph unreachable: ${err instanceof Error ? err.message : String(err)}`, {
      url: redactUrl(url),
    });
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 401) {
      throw new ValidationError('Microsoft rejected the access token. Re-connect the integration.', {
        status: resp.status,
      });
    }
    throw new IntegrationError(`Microsoft Graph error: HTTP ${resp.status} ${text.slice(0, 200)}`, {
      status: resp.status,
    });
  }
  return (await resp.json()) as OutlookGraphEnvelope;
}

function redactUrl(url: string): string {
  const u = new URL(url);
  u.search = '';
  return `${u.pathname}`;
}

// Keep `OUTLOOK_DEFAULT_SCOPES` re-exported so apps can compose their own provider config.
export { OUTLOOK_DEFAULT_SCOPES };

/**
 * Placeholder body for the auto-drafted Outlook reply.
 *
 * Deliberately says nothing about the substance of the message. The Bakery reply generator
 * (Phase 1) grounds its answers in the product/FAQ catalog; an email from an unknown sender has
 * no such grounding, so inventing a commitment ("your order ships Tuesday") would be exactly the
 * failure mode the catalog grounding exists to prevent. A human edits this in the Outbox before
 * approving — the draft exists to make the reply workflow reachable, not to answer the mail.
 */
function buildAcknowledgement(evt: OutlookMessageEvent): string {
  const who = evt.fromName?.trim() || evt.from;
  const subject = evt.subject && evt.subject !== '(no subject)' ? evt.subject : 'your message';
  return [
    `Hi ${who},`,
    '',
    `Thanks for your email about "${subject}". We have received it and a member of the team will reply shortly.`,
    '',
    'If your message is time-sensitive, please reply to this email so it reaches us directly.',
    '',
    'Best regards,',
    'FlowPilot',
  ].join('\n');
}
