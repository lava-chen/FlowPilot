import type { Queryable } from '../client.js';
import { newId, nowIso, NotFoundError } from '@flowpilot/shared';

/**
 * PKCE / OAuth state — short-lived. Stores:
 *   - `state`: the signed nonce we send to the IdP and check on callback.
 *   - `code_verifier_hash`: SHA-256 of the PKCE verifier (raw value is kept only in
 *     the user's session cookie for a few seconds; this column proves we issued it).
 *   - `return_to`: the dashboard path the user was on, for redirect after success.
 *   - `expires_at`: hard cap. Even if the user walks away, we garbage-collect on
 *     read and the consumer throws `ValidationError`.
 */
type Row = Record<string, unknown>;

export interface OAuthStateRecord {
  id: string;
  orgId: string;
  provider: string;
  state: string;
  codeVerifierHash: string;
  returnTo: string | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

const mapState = (r: Row): OAuthStateRecord => ({
  id: String(r['id']),
  orgId: String(r['org_id']),
  provider: String(r['provider']),
  state: String(r['state']),
  codeVerifierHash: String(r['code_verifier_hash']),
  returnTo: r['return_to'] === null || r['return_to'] === undefined ? null : String(r['return_to']),
  expiresAt: String(r['expires_at']),
  consumedAt: r['consumed_at'] === null || r['consumed_at'] === undefined ? null : String(r['consumed_at']),
  createdAt: String(r['created_at']),
});

export class OAuthStateRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    orgId: string;
    provider: string;
    state: string;
    codeVerifierHash: string;
    returnTo: string | null;
    ttlSeconds?: number;
  }): Promise<OAuthStateRecord> {
    const ttl = input.ttlSeconds ?? 600; // 10 min is plenty for an OAuth round-trip.
    const row = await this.db.one<Row>(
      `insert into oauth_states (id, org_id, provider, state, code_verifier_hash, return_to, expires_at)
       values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)
       returning *`,
      [newId('oauth'), input.orgId, input.provider, input.state, input.codeVerifierHash, input.returnTo, String(ttl)],
    );
    return mapState(row!);
  }

  async findByState(provider: string, state: string): Promise<OAuthStateRecord | null> {
    const row = await this.db.one<Row>(
      `select * from oauth_states
         where provider = $1 and state = $2
           and consumed_at is null
           and expires_at > now()
         order by created_at desc
         limit 1`,
      [provider, state],
    );
    return row ? mapState(row) : null;
  }

  async consume(id: string): Promise<void> {
    await this.db.query(
      `update oauth_states set consumed_at = now() where id = $1 and consumed_at is null`,
      [id],
    );
  }

  async purgeExpired(): Promise<void> {
    await this.db.query(
      `delete from oauth_states where expires_at < now() - interval '1 hour'`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* OAuth tokens                                                                */
/* -------------------------------------------------------------------------- */

export interface OAuthTokenBlob {
  accessCiphertext: string;
  accessIv: string;
  accessAuthTag: string;
  refreshCiphertext: string;
  refreshIv: string;
  refreshAuthTag: string;
  accessExpiresAt: string;
  scopes: string[];
  extra: Record<string, unknown>;
  refreshedAt: string;
  accountLabel: string;
}

const mapToken = (r: Row): OAuthTokenBlob => ({
  accountLabel: String(r['account_label']),
  accessCiphertext: String(r['access_ciphertext']),
  accessIv: String(r['access_iv']),
  accessAuthTag: String(r['access_auth_tag']),
  refreshCiphertext: String(r['refresh_ciphertext']),
  refreshIv: String(r['refresh_iv']),
  refreshAuthTag: String(r['refresh_auth_tag']),
  accessExpiresAt: String(r['access_expires_at']),
  scopes: (r['scopes'] ?? []) as string[],
  extra: (r['extra'] ?? {}) as Record<string, unknown>,
  refreshedAt: String(r['refreshed_at']),
});

type TokenRow = Record<string, unknown>;

export class OAuthTokenRepo {
  constructor(private readonly db: Queryable) {}

  async upsert(input: {
    orgId: string;
    provider: string;
    blob: OAuthTokenBlob;
  }): Promise<void> {
    await this.db.query(
      `insert into oauth_tokens (org_id, provider, account_label, access_ciphertext, access_iv, access_auth_tag,
                                refresh_ciphertext, refresh_iv, refresh_auth_tag, access_expires_at, scopes, extra, refreshed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::jsonb, now())
       on conflict (org_id, provider)
       do update set account_label = excluded.account_label,
                   access_ciphertext = excluded.access_ciphertext,
                   access_iv = excluded.access_iv,
                   access_auth_tag = excluded.access_auth_tag,
                   refresh_ciphertext = excluded.refresh_ciphertext,
                   refresh_iv = excluded.refresh_iv,
                   refresh_auth_tag = excluded.refresh_auth_tag,
                   access_expires_at = excluded.access_expires_at,
                   scopes = excluded.scopes,
                   extra = excluded.extra,
                   refreshed_at = now()`,
      [
        input.orgId,
        input.provider,
        input.blob.accountLabel,
        input.blob.accessCiphertext,
        input.blob.accessIv,
        input.blob.accessAuthTag,
        input.blob.refreshCiphertext,
        input.blob.refreshIv,
        input.blob.refreshAuthTag,
        input.blob.accessExpiresAt,
        input.blob.scopes,
        JSON.stringify(input.blob.extra),
      ],
    );
  }

  async get(orgId: string, provider: string): Promise<OAuthTokenBlob | null> {
    const row = await this.db.one<TokenRow>(
      'select * from oauth_tokens where org_id = $1 and provider = $2',
      [orgId, provider],
    );
    return row ? mapToken(row) : null;
  }

  async delete(orgId: string, provider: string): Promise<void> {
    await this.db.query(
      'delete from oauth_tokens where org_id = $1 and provider = $2',
      [orgId, provider],
    );
  }

  async require(orgId: string, provider: string): Promise<OAuthTokenBlob> {
    const got = await this.get(orgId, provider);
    if (!got) throw new NotFoundError(`OAuthToken(${provider})`);
    return got;
  }
}

/* -------------------------------------------------------------------------- */
/* Sync cursors (delta queries)                                                */
/* -------------------------------------------------------------------------- */

export interface SyncCursorRecord {
  orgId: string;
  provider: string;
  cursorKind: string;
  cursorValue: string;
  totalIngested: number;
  lastSyncedAt: string;
  metadata: Record<string, unknown>;
}

export class SyncCursorRepo {
  constructor(private readonly db: Queryable) {}

  async upsert(input: SyncCursorRecord): Promise<void> {
    await this.db.query(
      `insert into integration_sync_cursors (org_id, provider, cursor_kind, cursor_value, total_ingested, last_synced_at, metadata)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb)
       on conflict (org_id, provider, cursor_kind)
       do update set cursor_value = excluded.cursor_value,
                   total_ingested = integration_sync_cursors.total_ingested + excluded.total_ingested,
                   last_synced_at = excluded.last_synced_at,
                   metadata = excluded.metadata`,
      [
        input.orgId,
        input.provider,
        input.cursorKind,
        input.cursorValue,
        input.totalIngested,
        input.lastSyncedAt ?? nowIso(),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async get(orgId: string, provider: string, cursorKind: string): Promise<SyncCursorRecord | null> {
    const row = await this.db.one<Row>(
      'select * from integration_sync_cursors where org_id = $1 and provider = $2 and cursor_kind = $3',
      [orgId, provider, cursorKind],
    );
    if (!row) return null;
    return {
      orgId: String(row['org_id']),
      provider: String(row['provider']),
      cursorKind: String(row['cursor_kind']),
      cursorValue: String(row['cursor_value']),
      totalIngested: Number(row['total_ingested']),
      lastSyncedAt: String(row['last_synced_at']),
      metadata: (row['metadata'] ?? {}) as Record<string, unknown>,
    };
  }

  async list(orgId: string, provider: string): Promise<SyncCursorRecord[]> {
    const rows = await this.db.query<Row>(
      'select * from integration_sync_cursors where org_id = $1 and provider = $2 order by cursor_kind',
      [orgId, provider],
    );
    return rows.map((r) => ({
      orgId: String(r['org_id']),
      provider: String(r['provider']),
      cursorKind: String(r['cursor_kind']),
      cursorValue: String(r['cursor_value']),
      totalIngested: Number(r['total_ingested']),
      lastSyncedAt: String(r['last_synced_at']),
      metadata: (r['metadata'] ?? {}) as Record<string, unknown>,
    }));
  }

  async delete(orgId: string, provider: string, cursorKind: string): Promise<void> {
    await this.db.query(
      'delete from integration_sync_cursors where org_id = $1 and provider = $2 and cursor_kind = $3',
      [orgId, provider, cursorKind],
    );
  }
}
