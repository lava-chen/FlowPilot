import type { Actor, RequestRecord, Task } from '@flowpilot/domain';
import type { CoreServices } from '@flowpilot/core';
import type { IngestionOutcome } from './adapter.js';
import { ingestAndDraft } from './adapter.js';
import { MockEmailAdapter } from './mock-email.js';

export interface InboxTriggerResult {
  request: RequestRecord;
  deduplicated: boolean;
  draft: Task | null;
  /** Set when a request was ingested but could not become a draft without human input. */
  draftError: string | null;
  runId: string | null;
  templates: ReturnType<MockEmailAdapter['listTemplates']>;
}

/**
 * Drives the mock adapter from the dashboard ("Simulate inbound email").
 *
 * Kept as a service rather than a route handler so the MCP server could expose the same trigger
 * later, and so tests exercise the exact code path the UI uses.
 */
export class InboxTriggerService {
  private sequence = Date.now();

  constructor(private readonly core: CoreServices) {}

  async simulate(actor: Actor, input: { templateId: string; createDraft: boolean }): Promise<InboxTriggerResult> {
    const adapter = new MockEmailAdapter();
    this.sequence += 1;
    const message = MockEmailAdapter.message(input.templateId, this.sequence);

    const result = await ingestAndDraft(this.core, actor, adapter, message, { createDraft: input.createDraft });

    return {
      request: result.request,
      deduplicated: result.deduplicated,
      draft: result.draft,
      draftError:
        result.draft === null && !result.deduplicated
          ? 'The analyzer did not resolve a project, so no draft was created — finish this one in the AI Inbox.'
          : null,
      runId: result.runId,
      templates: adapter.listTemplates(),
    };
  }

  /** Re-analyze every unprocessed request — the "catch me up" button. */
  async analyzePending(actor: Actor): Promise<IngestionOutcome & { analyzed: number; errors: unknown[] }> {
    const result = await this.core.requests.analyze(actor, this.core.ai);
    return {
      accepted: result.analyzed,
      duplicates: [],
      drafts: [],
      runIds: [],
      analyzed: result.analyzed.length,
      errors: result.errors,
    };
  }
}
