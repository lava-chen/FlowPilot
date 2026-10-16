import type { Queryable } from '../client.js';
import { pgTextArray } from '../sql.js';
import { mapAuditEvent, mapCredential, mapIntegration } from '../mappers.js';
import type { ActorKind, AuditEvent, IntegrationConnection, Scope } from '@flowpilot/domain';

type Row = Record<string, unknown>;

export interface AuditInput {
  id: string;
  orgId: string;
  actorKind: ActorKind;
  actorId: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

export class AuditRepo {
  constructor(private readonly db: Queryable) {}

  async record(input: AuditInput): Promise<AuditEvent> {
    const row = await this.db.one<Row>(
      `insert into audit_events (id, org_id, actor_kind, actor_id, actor_label, action, entity_type, entity_id, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning *`,
      [
        input.id,
        input.orgId,
        input.actorKind,
        input.actorId,
        input.actorLabel,
        input.action,
        input.entityType,
        input.entityId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapAuditEvent(row!);
  }

  async list(orgId: string, filter: { limit: number; entityType?: string; entityId?: string; actorKind?: string }): Promise<AuditEvent[]> {
    const rows = await this.db.query<Row>(
      `select * from audit_events
        where org_id = $1
          and ($2::text is null or entity_type = $2)
          and ($3::text is null or entity_id = $3)
          and ($4::text is null or actor_kind = $4)
        order by created_at desc
        limit $5`,
      [orgId, filter.entityType ?? null, filter.entityId ?? null, filter.actorKind ?? null, filter.limit],
    );
    return rows.map(mapAuditEvent);
  }

  async countSince(orgId: string, sinceIso: string): Promise<number> {
    const row = await this.db.one<Row>('select count(*)::int as n from audit_events where org_id = $1 and created_at >= $2', [
      orgId,
      sinceIso,
    ]);
    return Number(row?.['n'] ?? 0);
  }
}

export interface StoredCredential extends Omit<ReturnType<typeof mapCredential>, 'scopes'> {
  scopes: Scope[];
  tokenHash: string;
}

export class CredentialRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    orgId: string;
    name: string;
    tokenPrefix: string;
    tokenHash: string;
    scopes: Scope[];
  }): Promise<StoredCredential> {
    const row = await this.db.one<Row>(
      `insert into agent_credentials (id, org_id, name, token_prefix, token_hash, scopes)
       values ($1,$2,$3,$4,$5,$6::text[]) returning *`,
      [input.id, input.orgId, input.name, input.tokenPrefix, input.tokenHash, pgTextArray(input.scopes)],
    );
    return { ...mapCredential(row!), tokenHash: String(row!['token_hash']) };
  }

  async findByHash(tokenHash: string): Promise<StoredCredential | null> {
    const row = await this.db.one<Row>('select * from agent_credentials where token_hash = $1', [tokenHash]);
    if (!row) return null;
    return { ...mapCredential(row), tokenHash: String(row['token_hash']) };
  }

  async list(orgId: string): Promise<Array<ReturnType<typeof mapCredential>>> {
    const rows = await this.db.query<Row>(
      'select id, org_id, name, token_prefix, scopes, revoked_at, last_used_at, created_at from agent_credentials where org_id = $1 order by created_at desc',
      [orgId],
    );
    return rows.map(mapCredential);
  }

  async touch(id: string): Promise<void> {
    await this.db.query('update agent_credentials set last_used_at = now() where id = $1', [id]);
  }

  async revoke(orgId: string, id: string): Promise<void> {
    await this.db.query('update agent_credentials set revoked_at = now() where id = $1 and org_id = $2 and revoked_at is null', [
      id,
      orgId,
    ]);
  }
}

export class IntegrationRepo {
  constructor(private readonly db: Queryable) {}

  async upsert(input: {
    id: string;
    orgId: string;
    provider: string;
    status: IntegrationConnection['status'];
    config?: Record<string, unknown>;
  }): Promise<IntegrationConnection> {
    const row = await this.db.one<Row>(
      `insert into integration_connections (id, org_id, provider, status, config)
       values ($1,$2,$3,$4,$5::jsonb)
       on conflict (org_id, provider)
       do update set status = excluded.status, config = excluded.config
       returning *`,
      [input.id, input.orgId, input.provider, input.status, JSON.stringify(input.config ?? {})],
    );
    return mapIntegration(row!);
  }

  async markEvent(orgId: string, provider: string, at: string): Promise<void> {
    await this.db.query('update integration_connections set last_event_at = $3 where org_id = $1 and provider = $2', [
      orgId,
      provider,
      at,
    ]);
  }

  async list(orgId: string): Promise<IntegrationConnection[]> {
    const rows = await this.db.query<Row>('select * from integration_connections where org_id = $1 order by provider', [
      orgId,
    ]);
    return rows.map(mapIntegration);
  }
}
