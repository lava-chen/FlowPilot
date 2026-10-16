import type { Queryable } from '../client.js';

type Row = Record<string, unknown>;

export interface StoredAiProviderSettings {
  orgId: string;
  provider: 'deterministic' | 'openai-compatible';
  baseUrl: string | null;
  model: string | null;
  apiKeyCiphertext: string | null;
  apiKeyIv: string | null;
  apiKeyAuthTag: string | null;
  updatedBy: string;
  updatedAt: string;
}

export class AiProviderSettingsRepo {
  constructor(private readonly db: Queryable) {}

  async find(orgId: string): Promise<StoredAiProviderSettings | null> {
    const row = await this.db.one<Row>('select * from ai_provider_settings where org_id = $1', [orgId]);
    return row ? mapRow(row) : null;
  }

  async upsert(input: Omit<StoredAiProviderSettings, 'updatedAt'>): Promise<StoredAiProviderSettings> {
    const row = await this.db.one<Row>(
      `insert into ai_provider_settings
        (org_id, provider, base_url, model, api_key_ciphertext, api_key_iv, api_key_auth_tag, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (org_id) do update set
         provider = excluded.provider,
         base_url = excluded.base_url,
         model = excluded.model,
         api_key_ciphertext = excluded.api_key_ciphertext,
         api_key_iv = excluded.api_key_iv,
         api_key_auth_tag = excluded.api_key_auth_tag,
         updated_by = excluded.updated_by,
         updated_at = now()
       returning *`,
      [
        input.orgId,
        input.provider,
        input.baseUrl,
        input.model,
        input.apiKeyCiphertext,
        input.apiKeyIv,
        input.apiKeyAuthTag,
        input.updatedBy,
      ],
    );
    return mapRow(row!);
  }
}

function mapRow(row: Row): StoredAiProviderSettings {
  return {
    orgId: String(row['org_id']),
    provider: String(row['provider']) as StoredAiProviderSettings['provider'],
    baseUrl: row['base_url'] == null ? null : String(row['base_url']),
    model: row['model'] == null ? null : String(row['model']),
    apiKeyCiphertext: row['api_key_ciphertext'] == null ? null : String(row['api_key_ciphertext']),
    apiKeyIv: row['api_key_iv'] == null ? null : String(row['api_key_iv']),
    apiKeyAuthTag: row['api_key_auth_tag'] == null ? null : String(row['api_key_auth_tag']),
    updatedBy: String(row['updated_by']),
    updatedAt: new Date(String(row['updated_at'])).toISOString(),
  };
}
