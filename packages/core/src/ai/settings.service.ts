import { actorId, type Actor } from '@flowpilot/domain';
import type { FlowPilotDb, StoredAiProviderSettings } from '@flowpilot/database';
import { IntegrationError, ValidationError } from '@flowpilot/shared';
import type { AuditService } from '../audit.service.js';
import { assertCan } from '../permissions.js';
import { DeterministicAiProvider } from './deterministic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { AiProvider } from './provider.js';
import { decryptSecret, encryptSecret } from './settings-crypto.js';

export interface AiProviderSettingsInput {
  provider: 'deterministic' | 'openai-compatible';
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface PublicAiProviderSettings {
  provider: 'deterministic' | 'openai-compatible';
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  source: 'organization' | 'environment' | 'default';
  updatedAt: string | null;
}

export class AiProviderSettingsService {
  constructor(
    private readonly db: FlowPilotDb,
    private readonly audit: AuditService,
    private readonly fallback: AiProvider,
    private readonly encryptionSecret: string | undefined,
  ) {}

  async get(actor: Actor): Promise<PublicAiProviderSettings> {
    assertCan(actor, 'integrations:manage');
    const stored = await this.db.repos.aiProviderSettings.find(actor.orgId);
    return stored ? this.publicFromStored(stored) : this.fallbackSettings();
  }

  async save(actor: Actor, input: AiProviderSettingsInput): Promise<PublicAiProviderSettings> {
    assertCan(actor, 'integrations:manage');
    if (actor.kind !== 'user') throw new ValidationError('Only a signed-in organization administrator can configure an AI provider.');

    const existing = await this.db.repos.aiProviderSettings.find(actor.orgId);
    let baseUrl: string | null = null;
    let model: string | null = null;
    let apiKeyCiphertext: string | null = null;
    let apiKeyIv: string | null = null;
    let apiKeyAuthTag: string | null = null;

    if (input.provider === 'openai-compatible') {
      baseUrl = validateBaseUrl(input.baseUrl ?? '');
      model = (input.model ?? '').trim();
      if (!model || model.length > 160) throw new ValidationError('Enter a model name (up to 160 characters).', { field: 'model' });

      const apiKey = input.apiKey?.trim();
      if (apiKey) {
        if (apiKey.length > 4096) throw new ValidationError('The API key is too long.', { field: 'apiKey' });
        if (!this.encryptionSecret) throw new IntegrationError('Server-side encryption is not configured for AI provider keys.');
        const encrypted = encryptSecret(apiKey, this.encryptionSecret);
        apiKeyCiphertext = encrypted.ciphertext;
        apiKeyIv = encrypted.iv;
        apiKeyAuthTag = encrypted.authTag;
      } else if (existing?.provider === 'openai-compatible' && existing.apiKeyCiphertext && existing.apiKeyIv && existing.apiKeyAuthTag) {
        apiKeyCiphertext = existing.apiKeyCiphertext;
        apiKeyIv = existing.apiKeyIv;
        apiKeyAuthTag = existing.apiKeyAuthTag;
      } else {
        throw new ValidationError('Enter an API key for the selected provider.', { field: 'apiKey' });
      }
    }

    const stored = await this.db.withTransaction(async (tx) => {
      const settings = await tx.repos.aiProviderSettings.upsert({
        orgId: actor.orgId,
        provider: input.provider,
        baseUrl,
        model,
        apiKeyCiphertext,
        apiKeyIv,
        apiKeyAuthTag,
        updatedBy: actorId(actor),
      });
      await this.audit.record(actor, 'ai_provider.settings_updated', 'ai_provider_settings', actor.orgId, {
        provider: settings.provider,
        model: settings.model,
        keyUpdated: Boolean(input.apiKey?.trim()),
      }, tx);
      return settings;
    });
    return this.publicFromStored(stored);
  }

  async testConnection(actor: Actor): Promise<{ ok: true; provider: string; model: string; externalRequest: boolean }> {
    assertCan(actor, 'integrations:manage');
    const provider = await this.resolveProvider(actor);
    if (!provider.testConnection) {
      return { ok: true, provider: provider.name, model: provider.model, externalRequest: false };
    }
    await provider.testConnection();
    await this.audit.record(actor, 'ai_provider.connection_tested', 'ai_provider_settings', actor.orgId, {
      provider: provider.name,
      model: provider.model,
      success: true,
    });
    return { ok: true, provider: provider.name, model: provider.model, externalRequest: true };
  }

  async resolveProvider(actor: Actor): Promise<AiProvider> {
    const stored = await this.db.repos.aiProviderSettings.find(actor.orgId);
    if (!stored) return this.fallback;
    if (stored.provider === 'deterministic') return new DeterministicAiProvider();
    if (!this.encryptionSecret || !stored.baseUrl || !stored.model || !stored.apiKeyCiphertext || !stored.apiKeyIv || !stored.apiKeyAuthTag) {
      throw new IntegrationError('The saved AI provider configuration is incomplete.');
    }

    let apiKey: string;
    try {
      apiKey = decryptSecret({ ciphertext: stored.apiKeyCiphertext, iv: stored.apiKeyIv, authTag: stored.apiKeyAuthTag }, this.encryptionSecret);
    } catch {
      throw new IntegrationError('The saved AI provider key could not be decrypted. Check that SESSION_SECRET has not changed.');
    }
    return new OpenAiCompatibleProvider({ baseUrl: stored.baseUrl, model: stored.model, apiKey });
  }

  private fallbackSettings(): PublicAiProviderSettings {
    const compatible = this.fallback.name === 'openai-compatible';
    return {
      provider: compatible ? 'openai-compatible' : 'deterministic',
      baseUrl: this.fallback.baseUrl ?? '',
      model: this.fallback.model,
      keyConfigured: compatible,
      source: compatible ? 'environment' : 'default',
      updatedAt: null,
    };
  }

  private publicFromStored(stored: StoredAiProviderSettings): PublicAiProviderSettings {
    return {
      provider: stored.provider,
      baseUrl: stored.baseUrl ?? '',
      model: stored.model ?? '',
      keyConfigured: Boolean(stored.apiKeyCiphertext),
      source: 'organization',
      updatedAt: stored.updatedAt,
    };
  }
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new ValidationError('Enter a valid HTTPS API base URL.', { field: 'baseUrl' }); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new ValidationError('Use an HTTPS API base URL without embedded credentials, query parameters, or fragments.', { field: 'baseUrl' });
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
