import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor, IntegrationCatalogStatus, IntegrationConnection } from '@flowpilot/domain';
import { newId, NotFoundError, ValidationError, ForbiddenError } from '@flowpilot/shared';
import { AuditService } from './audit.service.js';
import { assertCan } from './permissions.js';

/**
 * Integration management: connection CRUD + catalog status projection.
 *
 * The actual provider secrets live encrypted in `IntegrationConnection.config`. The shape is
 * provider-specific (WhatsApp vs Outlook), so we accept and return `unknown` for the
 * config blob and let the caller (UI / route handler) serialize. We never log `config`.
 */

export type IntegrationProvider = 'whatsapp-cloud' | 'outlook-graph' | 'generic-webhook' | 'mock-email';

export interface IntegrationCatalogEntry {
  provider: IntegrationProvider;
  displayName: string;
  status: IntegrationCatalogStatus;
  /** One-line summary; shown in the Integrations dashboard tile. */
  summary: string;
  /** Last event timestamp from the connection, if any. */
  lastEventAt: string | null;
  /** Optional: which channel the provider writes to. */
  channel: 'whatsapp' | 'email' | 'webhook' | 'mock';
}

export interface UpsertIntegrationInput {
  provider: IntegrationProvider;
  status: IntegrationCatalogStatus;
  config: Record<string, unknown>;
}

export class IntegrationService {
  constructor(
    private readonly db: FlowPilotDb,
    private readonly audit: AuditService,
  ) {}

  /** List *all known integrations* for the org, projecting catalog state. */
  async catalog(actor: Actor): Promise<IntegrationCatalogEntry[]> {
    assertCan(actor, 'integrations:read');
    const existing = await this.db.repos.integrations.list(actor.orgId);
    const byProvider = new Map(existing.map((c) => [c.provider as string, c]));

    const seed: IntegrationCatalogEntry[] = (
      [
        {
          provider: 'whatsapp-cloud' as const,
          displayName: 'WhatsApp Business',
          channel: 'whatsapp' as const,
          summary: 'Customer chat on WhatsApp Business Cloud (Meta).',
        },
        {
          provider: 'outlook-graph' as const,
          displayName: 'Microsoft Outlook',
          channel: 'email' as const,
          summary: 'Read & draft email via Microsoft Graph (Phase 2).',
        },
        {
          provider: 'generic-webhook' as const,
          displayName: 'Generic Webhook',
          channel: 'webhook' as const,
          summary: 'Outbound webhooks to any HTTPS endpoint (Phase 4).',
        },
        {
          provider: 'mock-email' as const,
          displayName: 'Mock Email',
          channel: 'mock' as const,
          summary: 'Simulated inbound mailbox — local demo, no credentials required.',
        },
      ] satisfies Array<{
        provider: IntegrationProvider;
        displayName: string;
        channel: IntegrationCatalogEntry['channel'];
        summary: string;
      }>
    ).map((entry) => {
      const conn = byProvider.get(entry.provider);
      if (!conn) {
        return { ...entry, status: providerDefaultStatus(entry.provider), lastEventAt: null };
      }
      return {
        ...entry,
        status: projectStatus(conn),
        lastEventAt: conn.lastEventAt,
      };
    });

    return seed;
  }

  async listConnections(actor: Actor): Promise<IntegrationConnection[]> {
    assertCan(actor, 'integrations:manage');
    return this.db.repos.integrations.list(actor.orgId);
  }

  async requireConnection(actor: Actor, provider: string): Promise<IntegrationConnection> {
    const conns = await this.db.repos.integrations.list(actor.orgId);
    const found = conns.find((c) => c.provider === provider);
    if (!found) throw new NotFoundError('IntegrationConnection', provider);
    return found;
  }

  async upsert(actor: Actor, input: UpsertIntegrationInput): Promise<IntegrationConnection> {
    assertCan(actor, 'integrations:manage');
    if (!input.provider) throw new ValidationError('Integration provider is required.', { field: 'provider' });
    if (!isPlainObject(input.config)) throw new ValidationError('Integration config must be an object.', { field: 'config' });
    const sanitized = redactConfig(input.config);

    const conn = await this.db.repos.integrations.upsert({
      id: newId('integration'),
      orgId: actor.orgId,
      provider: input.provider,
      status: mapCatalogToConnectionStatus(input.status),
      config: sanitized,
    });

    await this.audit.record(actor, 'integration.updated', 'integration_connection', conn.id, {
      provider: conn.provider,
      status: conn.status,
      catalogStatus: input.status,
    });
    return conn;
  }

  async disconnect(actor: Actor, provider: string): Promise<IntegrationConnection> {
    assertCan(actor, 'integrations:manage');
    if (actor.kind !== 'user') {
      throw new ForbiddenError('Disconnection requires a human user.', {
        capability: 'integrations:manage',
      });
    }
    const conn = await this.requireConnection(actor, provider);
    const updated = await this.db.repos.integrations.upsert({
      id: conn.id,
      orgId: conn.orgId,
      provider: conn.provider,
      status: 'disconnected',
      config: {},
    });
    await this.audit.record(actor, 'integration.disconnected', 'integration_connection', updated.id, {
      provider: updated.provider,
    });
    return updated;
  }
}

function providerDefaultStatus(provider: IntegrationProvider): IntegrationCatalogStatus {
  if (provider === 'mock-email') return 'mock';
  return 'not_configured';
}

function projectStatus(conn: IntegrationConnection): IntegrationCatalogStatus {
  if (conn.status === 'connected') return 'connected';
  if (conn.status === 'error') return 'error';
  // For WhatsApp Cloud we use the config to detect "configured but not yet verified"
  if (conn.provider === 'whatsapp-cloud' && Object.keys(conn.config ?? {}).length > 0) {
    return 'reauth_required';
  }
  return 'not_configured';
}

function mapCatalogToConnectionStatus(s: IntegrationCatalogStatus): IntegrationConnection['status'] {
  if (s === 'connected') return 'connected';
  if (s === 'error' || s === 'reauth_required') return 'error';
  return 'disconnected';
}

/** Strip obvious secrets before persisting to `config`. We still encrypt at rest, but: */
function redactConfig(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['phoneNumberId', 'businessAccountId', 'apiBase', 'verifyToken']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== 'string') continue;
    if (k === 'accessToken' || k === 'appSecret' || k === 'apiKey' || k.toLowerCase().includes('secret')) continue;
    if (allowed.has(k)) {
      out[k] = typeof v === 'string' ? v : undefined;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
