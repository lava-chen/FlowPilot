import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor, IntegrationCatalogStatus, IntegrationConnection } from '@flowpilot/domain';
import { newId, NotFoundError, ValidationError, ForbiddenError } from '@flowpilot/shared';
import { AuditService } from './audit.service.js';
import { assertCan } from './permissions.js';
import { encryptSecret, decryptSecret, type SecretContext } from './ai/settings-crypto.js';

/**
 * Integration management: connection CRUD + catalog status projection + secret storage.
 *
 * Non-secret configuration (`phoneNumberId`, `verifyToken`, `apiBase`, ...) lives in
 * `IntegrationConnection.config` and is safe to echo to the dashboard.
 *
 * Secrets (`accessToken`, `appSecret`) do NOT. They are encrypted with a per-secret AES-GCM
 * key derived from `SESSION_SECRET` and stored in `integration_secrets`; `config` never
 * receives them. `readSecrets()` is the only server-side path back to plaintext, and it is
 * deliberately not reachable from any HTTP route — the webhook and the send dispatcher call it
 * internally after resolving the org from an authenticated context.
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

/**
 * Canonical secret field names, and the AES-GCM context each one is encrypted under.
 *
 * Splitting the contexts means a leaked `accessToken` ciphertext cannot be decrypted with the
 * app-secret key. Each entry also pins which context is used, so a future field cannot be
 * added without deliberately choosing its key separation.
 */
const SECRET_FIELDS = {
  accessToken: 'integrationAccessToken',
  appSecret: 'integrationAppSecret',
} as const satisfies Record<string, SecretContext>;

export type IntegrationSecretName = keyof typeof SECRET_FIELDS;

export class IntegrationService {
  constructor(
    private readonly db: FlowPilotDb,
    private readonly audit: AuditService,
    private readonly rootSecret: string,
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

  /**
   * Read one connection's non-secret config by org, with no permission check.
   *
   * This exists for server-side dispatchers — the outbound send route and the webhook — which
   * have *already* established the org from an authenticated session (or from the connection
   * that the webhook URL resolved to). They need the config to build a channel driver, but a
   * `member` who can legitimately press "Send" does not hold `integrations:manage`, so routing
   * them through {@link listConnections} would either fail the send or require granting a scope
   * nobody should have. Callers must have resolved `orgId` themselves.
   */
  async getConnectionConfig(
    orgId: string,
    provider: string,
  ): Promise<Record<string, unknown> | null> {
    const conns = await this.db.repos.integrations.list(orgId);
    const found = conns.find((c) => c.provider === provider);
    return found ? ((found.config ?? {}) as Record<string, unknown>) : null;
  }

  /** Connection status by org, no permission check. Same dispatcher caveat as above. */
  async getConnectionStatus(orgId: string, provider: string): Promise<string | null> {
    const conns = await this.db.repos.integrations.list(orgId);
    const found = conns.find((c) => c.provider === provider);
    return found ? found.status : null;
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

    // Secrets are pulled out of `config` and stored encrypted in `integration_secrets`.
    // Whatever is left is non-secret configuration that is safe to echo to the dashboard.
    const { config: safeConfig, secrets } = splitSecrets(input.config);

    const conn = await this.db.repos.integrations.upsert({
      id: newId('integration'),
      orgId: actor.orgId,
      provider: input.provider,
      status: mapCatalogToConnectionStatus(input.status),
      config: safeConfig,
    });

    for (const [name, plaintext] of Object.entries(secrets)) {
      await this.writeSecret(actor, input.provider, name as IntegrationSecretName, plaintext);
    }

    await this.audit.record(actor, 'integration.updated', 'integration_connection', conn.id, {
      provider: conn.provider,
      status: conn.status,
      catalogStatus: input.status,
      // Names only — never values.
      secretsConfigured: Object.keys(secrets),
    });
    return conn;
  }

  /**
   * Read a provider's secrets in plaintext.
   *
   * Server-side only: no HTTP route calls this, because any route that can reach it can
   * exfiltrate Meta credentials. Callers are the webhook signature verifier and the outbound
   * dispatcher, both of which already resolved the org from an authenticated or
   * connection-derived context before getting here.
   *
   * Returns `null` for a secret that was never configured, and throws when a stored secret
   * cannot be decrypted (wrong `SESSION_SECRET`, tampered ciphertext) — a silent empty string
   * here would push the caller back into mock behaviour, which is the exact failure mode this
   * store exists to eliminate.
   */
  async readSecret(
    orgId: string,
    provider: string,
    name: IntegrationSecretName,
  ): Promise<string | null> {
    const record = await this.db.repos.integrationSecrets.get(orgId, provider, name);
    if (!record) return null;
    if (record.invalidatedAt) return null;
    const context = SECRET_FIELDS[name];
    try {
      return decryptSecret(
        { ciphertext: record.ciphertext, iv: record.iv, authTag: record.authTag },
        this.rootSecret,
        context,
      );
    } catch {
      throw new ValidationError(
        `Stored credential "${name}" for ${provider} could not be decrypted. Re-save the integration credentials.`,
        { provider, secret: name },
      );
    }
  }

  /** Which secret names exist for a provider — safe to return to the dashboard. */
  async listSecretNames(orgId: string, provider: string): Promise<string[]> {
    return this.db.repos.integrationSecrets.listNames(orgId, provider);
  }

  private async writeSecret(
    actor: Actor,
    provider: string,
    name: IntegrationSecretName,
    plaintext: string,
  ): Promise<void> {
    const context = SECRET_FIELDS[name];
    const blob = encryptSecret(plaintext, this.rootSecret, context);
    await this.db.repos.integrationSecrets.upsert({
      orgId: actor.orgId,
      provider,
      secretName: name,
      blob: {
        ciphertext: blob.ciphertext,
        iv: blob.iv,
        authTag: blob.authTag,
      },
    });
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
    // Credentials must not outlive the connection: a "disconnected" integration that still has a
    // usable access token is exactly the kind of thing that gets reconnected without the operator
    // realising the old credential was still on disk.
    await this.db.repos.integrationSecrets.delete(actor.orgId, provider);
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

/**
 * Split an incoming config blob into (a) non-secret config to persist on the connection and
 * (b) secret values to encrypt into `integration_secrets`.
 *
 * Note the inversion from the previous implementation: secrets used to be *dropped* here, which
 * meant the webhook signature check and the outbound dispatcher both read an empty string and
 * fell back to mock delivery. Anything that looks like a credential is now routed to the
 * encrypted store rather than discarded.
 */
function splitSecrets(input: Record<string, unknown>): {
  config: Record<string, unknown>;
  secrets: Partial<Record<IntegrationSecretName, string>>;
} {
  const secrets: Partial<Record<IntegrationSecretName, string>> = {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (isSecretField(k)) {
      // Only persist a string secret. An empty/absent value means "leave the stored one alone",
      // so a settings save that omits the token does not wipe a working credential.
      if (typeof v === 'string' && v.length > 0) secrets[k] = v;
      continue;
    }
    out[k] = v;
  }
  return { config: out, secrets };
}

function isSecretField(key: string): key is IntegrationSecretName {
  return key in SECRET_FIELDS;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
