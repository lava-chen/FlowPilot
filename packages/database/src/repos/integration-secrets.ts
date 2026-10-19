import type { Queryable } from '../client.js';

/**
 * Encrypted per-provider credentials for integrations that do *not* use OAuth.
 *
 * Same contract as `OAuthTokenRepo`, different lifecycle: OAuth tokens are refreshed by the
 * provider's grant, whereas these are pasted by a human once and rotated by re-saving the
 * settings form. Either way the plaintext never touches `integration_connections.config`,
 * because that blob is echoed to the dashboard UI.
 */
type Row = Record<string, unknown>;

export interface IntegrationSecretRecord {
  orgId: string;
  provider: string;
  secretName: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  invalidatedAt: string | null;
  updatedAt: string;
}

export interface IntegrationSecretBlob {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const mapSecret = (r: Row): IntegrationSecretRecord => ({
  orgId: String(r['org_id']),
  provider: String(r['provider']),
  secretName: String(r['secret_name']),
  ciphertext: String(r['ciphertext']),
  iv: String(r['iv']),
  authTag: String(r['auth_tag']),
  invalidatedAt:
    r['invalidated_at'] === null || r['invalidated_at'] === undefined ? null : String(r['invalidated_at']),
  updatedAt: String(r['updated_at']),
});

export class IntegrationSecretRepo {
  constructor(private readonly db: Queryable) {}

  /**
   * Insert or replace one secret. Each `secretName` is an independent row, so rotating the
   * access token never has to read-modify-write the app secret (and vice versa).
   */
  async upsert(input: {
    orgId: string;
    provider: string;
    secretName: string;
    blob: IntegrationSecretBlob;
  }): Promise<void> {
    await this.db.query(
      `insert into integration_secrets (org_id, provider, secret_name, ciphertext, iv, auth_tag)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (org_id, provider, secret_name)
       do update set ciphertext = excluded.ciphertext,
                   iv = excluded.iv,
                   auth_tag = excluded.auth_tag,
                   invalidated_at = null,
                   updated_at = now()`,
      [
        input.orgId,
        input.provider,
        input.secretName,
        input.blob.ciphertext,
        input.blob.iv,
        input.blob.authTag,
      ],
    );
  }

  async get(
    orgId: string,
    provider: string,
    secretName: string,
  ): Promise<IntegrationSecretRecord | null> {
    const row = await this.db.one<Row>(
      'select * from integration_secrets where org_id = $1 and provider = $2 and secret_name = $3',
      [orgId, provider, secretName],
    );
    return row ? mapSecret(row) : null;
  }

  /** All secrets for one provider — used by resolvers that need more than one (e.g. WhatsApp). */
  async list(orgId: string, provider: string): Promise<IntegrationSecretRecord[]> {
    const rows = await this.db.query<Row>(
      'select * from integration_secrets where org_id = $1 and provider = $2 order by secret_name',
      [orgId, provider],
    );
    return rows.map(mapSecret);
  }

  /** Names only — lets the dashboard show "which secrets are configured" without any ciphertext. */
  async listNames(orgId: string, provider: string): Promise<string[]> {
    const rows = await this.db.query<Row>(
      'select secret_name from integration_secrets where org_id = $1 and provider = $2 order by secret_name',
      [orgId, provider],
    );
    return rows.map((r) => String(r['secret_name']));
  }

  async delete(orgId: string, provider: string, secretName?: string): Promise<void> {
    if (secretName) {
      await this.db.query(
        'delete from integration_secrets where org_id = $1 and provider = $2 and secret_name = $3',
        [orgId, provider, secretName],
      );
      return;
    }
    await this.db.query('delete from integration_secrets where org_id = $1 and provider = $2', [
      orgId,
      provider,
    ]);
  }

  /**
   * Mark a credential unusable without deleting it, so the dashboard can distinguish
   * "never configured" from "configured then rejected by the provider".
   */
  async invalidate(orgId: string, provider: string, secretName: string): Promise<void> {
    await this.db.query(
      'update integration_secrets set invalidated_at = now() where org_id = $1 and provider = $2 and secret_name = $3',
      [orgId, provider, secretName],
    );
  }
}
