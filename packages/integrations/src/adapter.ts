import type { Actor, RequestRecord, Task } from '@flowpilot/domain';
import type { CoreServices } from '@flowpilot/core';
import type { NormalizedInboundMessage } from '@flowpilot/core';

/**
 * The integration seam.
 *
 * Every future connector (Gmail, Slack, Frame.io…) implements this one interface and hands over
 * a `NormalizedInboundMessage`. Everything downstream — dedupe, analysis, drafting, audit —
 * already works, which is why v0.1 ships exactly one adapter and no framework.
 *
 * The parts that are deliberately *not* built yet, and where they will live:
 *  - OAuth handshake  -> `authorize()` (per-adapter; token storage is `integration_connections.config`).
 *  - Webhook delivery -> the host route; `verifyWebhook()` is where signatures get checked.
 *  - Retry/backoff    -> the ingestion call site, which is already idempotent, so a retry is safe.
 *  - Dead-letter queue-> a `failed` request plus a `workflow_runs` row with `status='failed'`.
 */
export interface IntegrationAdapter {
  readonly provider: string;
  readonly displayName: string;
  /** True when the adapter is safe to trigger by hand from the dashboard (the mock one is). */
  readonly simulateInUi: boolean;

  /** Pulls new messages and feeds them to ingestion. Real adapters implement this. */
  poll(actor: Actor): Promise<IngestionOutcome>;

  /** Turns a raw provider payload into our normalized shape. */
  normalize(payload: unknown): NormalizedInboundMessage;

  /** Optional webhook path support; returns false when the signature is not trusted. */
  verifyWebhook?(headers: Record<string, string | undefined>, rawBody: string): boolean;
}

export interface IngestionOutcome {
  accepted: RequestRecord[];
  duplicates: RequestRecord[];
  drafts: Task[];
  runIds: string[];
}

/**
 * Shared runner: any adapter (mock today, Gmail tomorrow) funnels through this so the pipeline
 * — and therefore the audit trail — is identical no matter where the message came from.
 */
export async function ingestAndDraft(
  core: CoreServices,
  actor: Actor,
  adapter: IntegrationAdapter,
  message: NormalizedInboundMessage,
  options: { createDraft: boolean },
): Promise<{ request: RequestRecord; deduplicated: boolean; draft: Task | null; runId: string | null }> {
  const ingested = await core.requests.ingest(actor, adapter.normalize(message));
  // Everything below works on the record, not on the snapshot `ingest` returned: analysis and
  // drafting both update the request, and handing back the stale snapshot would tell the caller
  // the request is still "new" after a draft exists.
  const current = async (): Promise<RequestRecord> => core.requests.require(actor, ingested.request.id);

  if (ingested.deduplicated || !options.createDraft) {
    return { request: await current(), deduplicated: ingested.deduplicated, draft: null, runId: ingested.runId };
  }

  // A request that already has a draft is left alone rather than duplicated.
  const existing = await core.db.repos.tasks.findByRequest(actor.orgId, ingested.request.id);
  if (existing.length > 0) {
    return { request: await current(), deduplicated: true, draft: existing[0] ?? null, runId: ingested.runId };
  }

  const analysis = await core.requests.analyze(actor, core.ai, { requestId: ingested.request.id });
  if (analysis.errors.length > 0 || analysis.analyzed.length === 0) {
    return { request: await current(), deduplicated: false, draft: null, runId: ingested.runId };
  }

  const draft = await createDraftFromAnalysis(core, actor, ingested.request.id);
  return { request: await current(), deduplicated: false, draft, runId: ingested.runId };
}

async function createDraftFromAnalysis(core: CoreServices, actor: Actor, requestId: string): Promise<Task | null> {
  try {
    return await core.tasks.createDraftFromRequest(actor, requestId);
  } catch {
    // An unresolvable project is a normal outcome for a vague email: the request stays in the
    // inbox for a human to finish. It is not an error worth failing the whole run over.
    return null;
  }
}
