import type { Queryable } from '../client.js';
import { pgTextArray } from '../sql.js';
import { NotFoundError, OrganizationMismatchError } from '@flowpilot/shared';
import { mapRequest } from '../mappers.js';
import type { RequestAnalysis, RequestRecord, RequestStatus } from '@flowpilot/domain';

type Row = Record<string, unknown>;

export interface CreateRequestInput {
  id: string;
  orgId: string;
  source: 'email' | 'manual';
  sourceRef: string;
  externalId: string;
  rawFrom: string;
  rawSubject: string;
  rawBody: string;
  rawReceivedAt: string;
  clientId?: string | null;
  projectId?: string | null;
}

export class RequestRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateRequestInput): Promise<RequestRecord> {
    const row = await this.db.one<Row>(
      `insert into requests (id, org_id, source, source_ref, external_id, client_id, project_id,
                             raw_from, raw_subject, raw_body, raw_received_at, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'new')
       returning *`,
      [
        input.id,
        input.orgId,
        input.source,
        input.sourceRef,
        input.externalId,
        input.clientId ?? null,
        input.projectId ?? null,
        input.rawFrom,
        input.rawSubject,
        input.rawBody,
        input.rawReceivedAt,
      ],
    );
    return mapRequest(row!);
  }

  /** Idempotent lookup used before creating: a replayed webhook must not duplicate work. */
  async findByExternalId(orgId: string, sourceRef: string, externalId: string): Promise<RequestRecord | null> {
    const row = await this.db.one<Row>(
      'select * from requests where org_id = $1 and source_ref = $2 and external_id = $3',
      [orgId, sourceRef, externalId],
    );
    return row ? mapRequest(row) : null;
  }

  async list(orgId: string, filter: { status?: RequestStatus[]; limit: number }): Promise<RequestRecord[]> {
    const statuses = pgTextArray(filter.status);
    const rows = await this.db.query<Row>(
      `select * from requests
        where org_id = $1
          and (cardinality($2::text[]) = 0 or status = any($2::text[]))
        order by created_at desc
        limit $3`,
      [orgId, statuses, filter.limit],
    );
    return rows.map(mapRequest);
  }

  async findById(orgId: string, id: string): Promise<RequestRecord | null> {
    const row = await this.db.one<Row>('select * from requests where id = $1 and org_id = $2', [id, orgId]);
    return row ? mapRequest(row) : null;
  }

  async require(orgId: string, id: string): Promise<RequestRecord> {
    const request = await this.findById(orgId, id);
    if (request) return request;
    const anyRow = await this.db.one<Row>('select org_id from requests where id = $1', [id]);
    if (anyRow) throw new OrganizationMismatchError('Request', id);
    throw new NotFoundError('Request', id);
  }

  async setAnalysis(orgId: string, id: string, analysis: RequestAnalysis, status: RequestStatus): Promise<RequestRecord> {
    const row = await this.db.one<Row>(
      `update requests set analysis = $3::jsonb, status = $4
        where id = $1 and org_id = $2 returning *`,
      [id, orgId, JSON.stringify(analysis), status],
    );
    if (!row) throw new NotFoundError('Request', id);
    return mapRequest(row);
  }

  async setStatus(orgId: string, id: string, status: RequestStatus): Promise<RequestRecord> {
    const row = await this.db.one<Row>('update requests set status = $3 where id = $1 and org_id = $2 returning *', [
      id,
      orgId,
      status,
    ]);
    if (!row) throw new NotFoundError('Request', id);
    return mapRequest(row);
  }

  async linkProject(orgId: string, id: string, projectId: string | null, clientId: string | null): Promise<void> {
    await this.db.query('update requests set project_id = $3, client_id = $4 where id = $1 and org_id = $2', [
      id,
      orgId,
      projectId,
      clientId,
    ]);
  }

  async countsByStatus(orgId: string): Promise<Record<string, number>> {
    const rows = await this.db.query<Row>('select status, count(*)::int as n from requests where org_id = $1 group by status', [
      orgId,
    ]);
    return Object.fromEntries(rows.map((r) => [String(r['status']), Number(r['n'])]));
  }
}
