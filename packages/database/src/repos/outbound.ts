import type { Queryable } from '../client.js';
import { NotFoundError, OrganizationMismatchError } from '@flowpilot/shared';
import type {
  OutboundAction,
  OutboundActionChannel,
  OutboundActionStatus,
  ActorKind,
} from '@flowpilot/domain';

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const nullableStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const nullableIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v);

const mapOutbound = (r: Row): OutboundAction => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  channel: str(r['channel']) as OutboundActionChannel,
  provider: str(r['provider']),
  to: str(r['to_recipient']),
  subject: nullableStr(r['subject']),
  body: str(r['body']),
  requestId: nullableStr(r['request_id']),
  leadId: nullableStr(r['lead_id']),
  externalMessageId: nullableStr(r['external_message_id']),
  status: str(r['status']) as OutboundActionStatus,
  errorMessage: nullableStr(r['error_message']),
  dedupeKey: str(r['dedupe_key']),
  createdBy: str(r['created_by']),
  approvedBy: nullableStr(r['approved_by']),
  approvedByLabel: nullableStr(r['approved_by_label']),
  approvedAt: nullableIso(r['approved_at']),
  approvalNote: nullableStr(r['approval_note']),
  sentAt: nullableIso(r['sent_at']),
  createdAt: iso(r['created_at']),
  updatedAt: iso(r['updated_at']),
});

export interface CreateOutboundInput {
  id: string;
  orgId: string;
  channel: OutboundActionChannel;
  provider: string;
  to: string;
  subject: string | null;
  body: string;
  requestId: string | null;
  leadId: string | null;
  dedupeKey: string;
  createdBy: string;
  status?: OutboundActionStatus;
}

export class OutboundActionRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateOutboundInput): Promise<OutboundAction> {
    const row = await this.db.one<Row>(
      `insert into outbound_actions
         (id, org_id, channel, provider, to_recipient, subject, body, request_id, lead_id, dedupe_key, created_by, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12,'draft'))
       returning *`,
      [
        input.id,
        input.orgId,
        input.channel,
        input.provider,
        input.to,
        input.subject,
        input.body,
        input.requestId,
        input.leadId,
        input.dedupeKey,
        input.createdBy,
        input.status ?? null,
      ],
    );
    return mapOutbound(row!);
  }

  async findById(orgId: string, id: string): Promise<OutboundAction | null> {
    const row = await this.db.one<Row>(
      'select * from outbound_actions where id = $1 and org_id = $2',
      [id, orgId],
    );
    return row ? mapOutbound(row) : null;
  }

  async findByDedupeKey(orgId: string, channel: string, dedupeKey: string): Promise<OutboundAction | null> {
    const row = await this.db.one<Row>(
      'select * from outbound_actions where org_id = $1 and channel = $2 and dedupe_key = $3',
      [orgId, channel, dedupeKey],
    );
    return row ? mapOutbound(row) : null;
  }

  async findByExternalMessageId(orgId: string, externalMessageId: string): Promise<OutboundAction | null> {
    const row = await this.db.one<Row>(
      'select * from outbound_actions where org_id = $1 and external_message_id = $2',
      [orgId, externalMessageId],
    );
    return row ? mapOutbound(row) : null;
  }

  async require(orgId: string, id: string): Promise<OutboundAction> {
    const action = await this.findById(orgId, id);
    if (action) return action;
    const anyRow = await this.db.one<Row>('select org_id from outbound_actions where id = $1', [id]);
    if (anyRow) throw new OrganizationMismatchError('OutboundAction', id);
    throw new NotFoundError('OutboundAction', id);
  }

  async list(
    orgId: string,
    filter: { status?: OutboundActionStatus[]; limit: number; requestId?: string },
  ): Promise<OutboundAction[]> {
    const statuses = filter.status ?? [];
    const params: unknown[] = [orgId];
    let where = 'org_id = $1';
    if (statuses.length > 0) {
      params.push(statuses);
      where += ` and status = any($${params.length}::text[])`;
    }
    if (filter.requestId) {
      params.push(filter.requestId);
      where += ` and request_id = $${params.length}`;
    }
    params.push(filter.limit);
    const rows = await this.db.query<Row>(
      `select * from outbound_actions where ${where} order by created_at desc limit $${params.length}`,
      params,
    );
    return rows.map(mapOutbound);
  }

  async updateStatus(
    orgId: string,
    id: string,
    nextStatus: OutboundActionStatus,
    extra: {
      approvedBy?: string | null;
      approvedByLabel?: string | null;
      approvedAt?: string | null;
      approvalNote?: string | null;
      externalMessageId?: string | null;
      errorMessage?: string | null;
      sentAt?: string | null;
    } = {},
  ): Promise<OutboundAction> {
    const params: unknown[] = [nextStatus];
    const sets: string[] = ['status = $1', 'updated_at = now()'];
    if (extra.approvedBy !== undefined) {
      params.push(extra.approvedBy);
      sets.push(`approved_by = $${params.length}`);
    }
    if (extra.approvedByLabel !== undefined) {
      params.push(extra.approvedByLabel);
      sets.push(`approved_by_label = $${params.length}`);
    }
    if (extra.approvedAt !== undefined) {
      params.push(extra.approvedAt);
      sets.push(`approved_at = $${params.length}`);
    }
    if (extra.approvalNote !== undefined) {
      params.push(extra.approvalNote);
      sets.push(`approval_note = $${params.length}`);
    }
    if (extra.externalMessageId !== undefined) {
      params.push(extra.externalMessageId);
      sets.push(`external_message_id = $${params.length}`);
    }
    if (extra.errorMessage !== undefined) {
      params.push(extra.errorMessage);
      sets.push(`error_message = $${params.length}`);
    }
    if (extra.sentAt !== undefined) {
      params.push(extra.sentAt);
      sets.push(`sent_at = $${params.length}`);
    }
    params.push(id, orgId);
    const row = await this.db.one<Row>(
      `update outbound_actions set ${sets.join(', ')} where id = $${params.length - 1} and org_id = $${params.length} returning *`,
      params,
    );
    if (!row) throw new NotFoundError('OutboundAction', id);
    return mapOutbound(row);
  }

  async recordEvent(input: {
    id: string;
    orgId: string;
    actionId: string;
    fromStatus: OutboundActionStatus | null;
    toStatus: OutboundActionStatus;
    actorKind: ActorKind;
    actorId: string;
    actorLabel: string;
    note?: string | null;
    errorCode?: string | null;
    errorTitle?: string | null;
    errorBody?: string | null;
  }): Promise<void> {
    await this.db.query(
      `insert into outbound_action_events
         (id, org_id, action_id, from_status, to_status, actor_kind, actor_id, actor_label, note, error_code, error_title, error_body)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.id,
        input.orgId,
        input.actionId,
        input.fromStatus,
        input.toStatus,
        input.actorKind,
        input.actorId,
        input.actorLabel,
        input.note ?? null,
        input.errorCode ?? null,
        input.errorTitle ?? null,
        input.errorBody ?? null,
      ],
    );
  }

  async listEvents(orgId: string, actionId: string, limit = 50): Promise<Array<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    actorKind: string;
    actorId: string;
    actorLabel: string;
    note: string | null;
    errorCode: string | null;
    errorTitle: string | null;
    errorBody: string | null;
    createdAt: string;
  }>> {
    const rows = await this.db.query<Row>(
      `select id, from_status, to_status, actor_kind, actor_id, actor_label, note, error_code, error_title, error_body, created_at
         from outbound_action_events
         where org_id = $1 and action_id = $2
         order by created_at desc
         limit $3`,
      [orgId, actionId, limit],
    );
    return rows.map((r) => ({
      id: str(r['id']),
      fromStatus: nullableStr(r['from_status']),
      toStatus: str(r['to_status']),
      actorKind: str(r['actor_kind']),
      actorId: str(r['actor_id']),
      actorLabel: str(r['actor_label']),
      note: nullableStr(r['note']),
      errorCode: nullableStr(r['error_code']),
      errorTitle: nullableStr(r['error_title']),
      errorBody: nullableStr(r['error_body']),
      createdAt: iso(r['created_at']),
    }));
  }
}

/* -------------------------------------------------------------------------- */
/* Leads                                                                       */
/* -------------------------------------------------------------------------- */

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'won' | 'lost' | 'archived';
export type LeadSource = 'whatsapp' | 'email' | 'manual' | 'webhook';

const strRow = (r: Row, k: string): string => String(r[k]);
const nullableStrRow = (r: Row, k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]));

export interface Lead {
  id: string;
  orgId: string;
  source: LeadSource;
  contactName: string | null;
  contactChannel: string;
  contactMeta: Record<string, unknown>;
  intent: string | null;
  intentLabel: string | null;
  status: LeadStatus;
  notes: string | null;
  requestId: string | null;
  taskId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const mapLead = (r: Row): Lead => ({
  id: strRow(r, 'id'),
  orgId: strRow(r, 'org_id'),
  source: strRow(r, 'source') as LeadSource,
  contactName: nullableStrRow(r, 'contact_name'),
  contactChannel: strRow(r, 'contact_channel'),
  contactMeta: (r['contact_meta'] ?? {}) as Record<string, unknown>,
  intent: nullableStrRow(r, 'intent'),
  intentLabel: nullableStrRow(r, 'intent_label'),
  status: strRow(r, 'status') as LeadStatus,
  notes: nullableStrRow(r, 'notes'),
  requestId: nullableStrRow(r, 'request_id'),
  taskId: nullableStrRow(r, 'task_id'),
  createdBy: strRow(r, 'created_by'),
  createdAt: iso(r['created_at']),
  updatedAt: iso(r['updated_at']),
});

export class LeadRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    orgId: string;
    source: LeadSource;
    contactName: string | null;
    contactChannel: string;
    contactMeta?: Record<string, unknown>;
    intent?: string | null;
    intentLabel?: string | null;
    notes?: string | null;
    requestId?: string | null;
    taskId?: string | null;
    createdBy: string;
  }): Promise<Lead> {
    const row = await this.db.one<Row>(
      `insert into leads
         (id, org_id, source, contact_name, contact_channel, contact_meta, intent, intent_label, notes, request_id, task_id, created_by)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
       returning *`,
      [
        input.id,
        input.orgId,
        input.source,
        input.contactName,
        input.contactChannel,
        JSON.stringify(input.contactMeta ?? {}),
        input.intent ?? null,
        input.intentLabel ?? null,
        input.notes ?? null,
        input.requestId ?? null,
        input.taskId ?? null,
        input.createdBy,
      ],
    );
    return mapLead(row!);
  }

  async findByContact(orgId: string, contactChannel: string): Promise<Lead | null> {
    const row = await this.db.one<Row>(
      'select * from leads where org_id = $1 and contact_channel = $2 order by created_at desc limit 1',
      [orgId, contactChannel],
    );
    return row ? mapLead(row) : null;
  }

  async findById(orgId: string, id: string): Promise<Lead | null> {
    const row = await this.db.one<Row>('select * from leads where id = $1 and org_id = $2', [id, orgId]);
    return row ? mapLead(row) : null;
  }

  async list(
    orgId: string,
    filter: { status?: LeadStatus[]; limit: number },
  ): Promise<Lead[]> {
    const params: unknown[] = [orgId];
    let where = 'org_id = $1';
    if (filter.status && filter.status.length > 0) {
      params.push(filter.status);
      where += ` and status = any($${params.length}::text[])`;
    }
    params.push(filter.limit);
    const rows = await this.db.query<Row>(
      `select * from leads where ${where} order by created_at desc limit $${params.length}`,
      params,
    );
    return rows.map(mapLead);
  }

  async updateStatus(orgId: string, id: string, status: LeadStatus, notes?: string | null): Promise<Lead> {
    const params: unknown[] = [status];
    let sets = 'status = $1, updated_at = now()';
    if (notes !== undefined) {
      params.push(notes);
      sets += `, notes = $${params.length}`;
    }
    params.push(id, orgId);
    const row = await this.db.one<Row>(
      `update leads set ${sets} where id = $${params.length - 1} and org_id = $${params.length} returning *`,
      params,
    );
    if (!row) throw new NotFoundError('Lead', id);
    return mapLead(row);
  }
}

/* -------------------------------------------------------------------------- */
/* Business catalog (products / faqs / business hours)                          */
/* -------------------------------------------------------------------------- */

export interface Product {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  currency: string;
  inStock: boolean;
  category: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const mapProduct = (r: Row): Product => ({
  id: strRow(r, 'id'),
  orgId: strRow(r, 'org_id'),
  name: strRow(r, 'name'),
  description: nullableStrRow(r, 'description'),
  priceCents: r['price_cents'] === null || r['price_cents'] === undefined ? null : Number(r['price_cents']),
  currency: strRow(r, 'currency'),
  inStock: Boolean(r['in_stock']),
  category: nullableStrRow(r, 'category'),
  metadata: (r['metadata'] ?? {}) as Record<string, unknown>,
  createdAt: iso(r['created_at']),
  updatedAt: iso(r['updated_at']),
});

export class ProductRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    orgId: string;
    name: string;
    description?: string | null;
    priceCents?: number | null;
    currency?: string;
    inStock?: boolean;
    category?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<Product> {
    const row = await this.db.one<Row>(
      `insert into products (id, org_id, name, description, price_cents, currency, in_stock, category, metadata)
       values ($1,$2,$3,$4,$5,$6,coalesce($7, true),$8,$9::jsonb)
       returning *`,
      [
        input.id,
        input.orgId,
        input.name,
        input.description ?? null,
        input.priceCents ?? null,
        input.currency ?? 'USD',
        input.inStock ?? null,
        input.category ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapProduct(row!);
  }

  async list(orgId: string): Promise<Product[]> {
    const rows = await this.db.query<Row>(
      'select * from products where org_id = $1 order by category nulls last, name',
      [orgId],
    );
    return rows.map(mapProduct);
  }

  async findById(orgId: string, id: string): Promise<Product | null> {
    const row = await this.db.one<Row>('select * from products where id = $1 and org_id = $2', [id, orgId]);
    return row ? mapProduct(row) : null;
  }

  async findByNames(orgId: string, names: string[]): Promise<Product[]> {
    if (names.length === 0) return [];
    const rows = await this.db.query<Row>(
      `select * from products where org_id = $1 and lower(name) = any($2::text[])`,
      [orgId, names.map((n) => n.toLowerCase())],
    );
    return rows.map(mapProduct);
  }
}

export interface Faq {
  id: string;
  orgId: string;
  question: string;
  answer: string;
  tags: string[];
  sortOrder: number;
  createdAt: string;
}

const mapFaq = (r: Row): Faq => ({
  id: strRow(r, 'id'),
  orgId: strRow(r, 'org_id'),
  question: strRow(r, 'question'),
  answer: strRow(r, 'answer'),
  tags: (r['tags'] ?? []) as string[],
  sortOrder: Number(r['sort_order']),
  createdAt: iso(r['created_at']),
});

export class FaqRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    orgId: string;
    question: string;
    answer: string;
    tags?: string[];
    sortOrder?: number;
  }): Promise<Faq> {
    const row = await this.db.one<Row>(
      `insert into faqs (id, org_id, question, answer, tags, sort_order)
       values ($1,$2,$3,$4,$5::text[],coalesce($6,0))
       returning *`,
      [
        input.id,
        input.orgId,
        input.question,
        input.answer,
        input.tags ?? [],
        input.sortOrder ?? null,
      ],
    );
    return mapFaq(row!);
  }

  async list(orgId: string): Promise<Faq[]> {
    const rows = await this.db.query<Row>(
      'select * from faqs where org_id = $1 order by sort_order, question',
      [orgId],
    );
    return rows.map(mapFaq);
  }
}

export interface BusinessHourRow {
  id: string;
  orgId: string;
  timezone: string;
  weekday: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
}

const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Weekday = (typeof weekdays)[number];

const mapHours = (r: Row): BusinessHourRow => ({
  id: strRow(r, 'id'),
  orgId: strRow(r, 'org_id'),
  timezone: strRow(r, 'timezone'),
  weekday: strRow(r, 'weekday') as Weekday,
  isClosed: Boolean(r['is_closed']),
  openTime: nullableStrRow(r, 'open_time'),
  closeTime: nullableStrRow(r, 'close_time'),
});

export class BusinessHoursRepo {
  constructor(private readonly db: Queryable) {}

  async set(
    orgId: string,
    entries: Array<{ weekday: Weekday; isClosed: boolean; openTime: string | null; closeTime: string | null; timezone: string }>,
  ): Promise<BusinessHourRow[]> {
    if (entries.length === 0) return [];
    const rows: BusinessHourRow[] = [];
    for (const e of entries) {
      const id = `hours_${orgId}_${e.weekday}`;
      const row = await this.db.one<Row>(
        `insert into business_hours (id, org_id, timezone, weekday, is_closed, open_time, close_time)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (org_id, weekday)
         do update set is_closed = excluded.is_closed, open_time = excluded.open_time, close_time = excluded.close_time, timezone = excluded.timezone
         returning *`,
        [id, orgId, e.timezone, e.weekday, e.isClosed, e.openTime, e.closeTime],
      );
      rows.push(mapHours(row!));
    }
    return rows;
  }

  async list(orgId: string): Promise<BusinessHourRow[]> {
    const rows = await this.db.query<Row>(
      `select * from business_hours where org_id = $1 order by case weekday
         when 'mon' then 1 when 'tue' then 2 when 'wed' then 3 when 'thu' then 4
         when 'fri' then 5 when 'sat' then 6 when 'sun' then 7 end`,
      [orgId],
    );
    return rows.map(mapHours);
  }
}
