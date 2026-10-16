import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor, RequestRecord } from '@flowpilot/domain';
import { idempotencyKey, newId, nowIso, ValidationError } from '@flowpilot/shared';
import type { WorkflowFactory } from './services.js';
import type { AuditService } from './audit.service.js';
import { assertCan } from './permissions.js';
import type { AiProvider } from './ai/provider.js';

export interface NormalizedInboundMessage {
  provider: string;
  externalId: string;
  from: string;
  fromName?: string;
  subject: string;
  body: string;
  receivedAt?: string;
}

/**
 * Turns a normalized inbound message (from any integration) into a `Request`.
 *
 * Idempotency is the whole point of this method: providers retry, users double-click, webhooks
 * redeliver. The unique key is `(org, provider, externalId)` — a duplicate returns the original
 * request with `deduplicated: true` instead of creating a second one.
 */
export class IngestionService {
  constructor(
    private readonly db: FlowPilotDb,
    private readonly workflowsFor: WorkflowFactory,
    private readonly audit: AuditService,
  ) {}

  async ingest(
    actor: Actor,
    message: NormalizedInboundMessage,
  ): Promise<{ request: RequestRecord; deduplicated: boolean; runId: string | null }> {
    assertCan(actor, 'requests:ingest');
    this.validateMessage(message);

    const workflows = this.workflowsFor(actor);
    const sourceRef = idempotencyKey(message.provider, message.externalId);
    const existing = await this.db.repos.requests.findByExternalId(actor.orgId, sourceRef, message.externalId);
    if (existing) {
      return { request: existing, deduplicated: true, runId: null };
    }

    const run = await workflows.start({
      trigger: message.provider === 'mock-email' ? 'mock_email' : 'system',
      steps: [
        {
          key: 'ingest',
          label: 'Ingest inbound message',
          status: 'running',
          startedAt: nowIso(),
          finishedAt: null,
          detail: { provider: message.provider, externalId: message.externalId },
          error: null,
        },
      ],
    });

    try {
      const request = await this.db.repos.requests.create({
        id: newId('request'),
        orgId: actor.orgId,
        source: 'email',
        sourceRef,
        externalId: message.externalId,
        rawFrom: message.fromName ? `${message.fromName} <${message.from}>` : message.from,
        rawSubject: message.subject,
        rawBody: message.body,
        rawReceivedAt: message.receivedAt ?? nowIso(),
      });

      await this.db.repos.integrations.markEvent(actor.orgId, message.provider, message.receivedAt ?? nowIso());

      await workflows.step(run, {
        key: 'ingest',
        label: 'Ingest inbound message',
        status: 'succeeded',
        detail: { provider: message.provider, externalId: message.externalId, requestId: request.id },
      });

      await this.audit.record(actor, 'request.ingested', 'request', request.id, {
        source: message.provider,
        externalId: message.externalId,
        from: message.from,
      });

      return { request, deduplicated: false, runId: run.id };
    } catch (error) {
      await workflows.finish(run, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async list(actor: Actor, filter: { status?: RequestRecord['status'][]; limit: number }): Promise<RequestRecord[]> {
    assertCan(actor, 'requests:read');
    return this.db.repos.requests.list(actor.orgId, filter);
  }

  async require(actor: Actor, id: string): Promise<RequestRecord> {
    assertCan(actor, 'requests:read');
    return this.db.repos.requests.require(actor.orgId, id);
  }

  /**
   * Analyzes one request, or every not-yet-analyzed request, and stores the extraction.
   *
   * Per-request failures are collected instead of thrown: one malformed email must not lose the
   * other four extractions in the same inbox sweep.
   */
  async analyze(
    actor: Actor,
    ai: AiProvider,
    input: { requestId?: string } = {},
  ): Promise<{ analyzed: RequestRecord[]; errors: Array<{ requestId: string; error: string }> }> {
    assertCan(actor, 'requests:analyze');

    const workflows = this.workflowsFor(actor);
    const targets = input.requestId
      ? [await this.db.repos.requests.require(actor.orgId, input.requestId)]
      : await this.db.repos.requests.list(actor.orgId, { status: ['new'], limit: 25 });

    const run = await workflows.start({
      trigger: actor.kind === 'agent' ? 'mcp' : 'manual',
      steps: [
        {
          key: 'analyze',
          label: `AI analysis (${ai.name})`,
          status: 'running',
          startedAt: nowIso(),
          finishedAt: null,
          detail: { provider: ai.name, model: ai.model, targets: targets.length },
          error: null,
        },
      ],
    });

    const analyzed: RequestRecord[] = [];
    const errors: Array<{ requestId: string; error: string }> = [];

    for (const request of targets) {
      try {
        const analysis = await this.runAnalysis(actor, ai, request);
        await this.db.repos.requests.setAnalysis(actor.orgId, request.id, analysis, 'analyzed');
        analyzed.push(await this.db.repos.requests.require(actor.orgId, request.id));
        await this.audit.record(actor, 'request.analyzed', 'request', request.id, {
          provider: ai.name,
          confidence: analysis.confidence,
          needsHumanReview: analysis.needsHumanReview,
          via: actor.kind === 'agent' ? 'mcp' : 'dashboard',
        });
      } catch (error) {
        errors.push({ requestId: request.id, error: error instanceof Error ? error.message : String(error) });
        await this.db.repos.requests.setStatus(actor.orgId, request.id, 'failed').catch(() => undefined);
      }
    }

    await workflows.step(run, {
      key: 'analyze',
      label: `AI analysis (${ai.name})`,
      status: errors.length === 0 ? 'succeeded' : 'failed',
      detail: { provider: ai.name, model: ai.model, analyzed: analyzed.length, failed: errors.length },
      error: errors[0]?.error ?? null,
    });
    await workflows.finish(run, errors.length > 0 ? 'failed' : 'succeeded', errors[0]?.error ?? null);

    return { analyzed, errors };
  }

  private async runAnalysis(actor: Actor, ai: AiProvider, request: RequestRecord) {
    const [clients, projects, members] = await Promise.all([
      this.db.repos.clients.list(actor.orgId),
      this.db.repos.projects.list(actor.orgId),
      this.db.repos.users.listByOrg(actor.orgId),
    ]);
    const loadByUser = await this.db.repos.tasks.countByAssignee(actor.orgId);
    const today = new Date().toISOString().slice(0, 10);

    const analysis = await ai.analyze({
      request,
      clients: clients.map((c) => ({ id: c.id, name: c.name, industry: c.industry })),
      projects: projects.map((p) => ({ id: p.id, name: p.name, code: p.code, clientId: p.clientId, dueDate: p.dueDate })),
      members: members.map((m) => ({
        id: m.id,
        fullName: m.fullName,
        title: m.title,
        role: m.role,
        activeTaskCount: loadByUser[m.id] ?? 0,
      })),
      today,
    });

    // Persist the grounding so the inbox can link this request to real records.
    if (analysis.projectId) {
      await this.db.repos.requests.linkProject(actor.orgId, request.id, analysis.projectId, analysis.clientId);
    }
    return analysis;
  }

  async linkRequest(actor: Actor, requestId: string, projectId: string | null, clientId: string | null): Promise<void> {
    assertCan(actor, 'requests:read');
    await this.db.repos.requests.linkProject(actor.orgId, requestId, projectId, clientId);
  }

  validateMessage(message: NormalizedInboundMessage): void {
    if (!message.from.includes('@')) {
      throw new ValidationError('Inbound message is missing a valid sender address.', { field: 'from' });
    }
    if (message.body.trim().length === 0) {
      throw new ValidationError('Inbound message body is empty.', { field: 'body' });
    }
    if (!message.subject.trim()) {
      throw new ValidationError('Inbound message has no subject.', { field: 'subject' });
    }
  }
}
