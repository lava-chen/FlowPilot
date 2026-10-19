-- FlowPilot v0.2 — WhatsApp Cloud API + outbound actions + retail bakery demo data
--
-- Three concerns live together because they share one feature flag (Phase 1 = WhatsApp):
--
--   1) `outbound_actions` — draft, approve, and audit customer-visible sends.
--   2) `integration_catalog` rows expand `integration_connections` with provider metadata.
--   3) `products`, `faqs`, `business_hours` — small sets of business data the Retail Bakery
--      demo tenant uses to ground AI replies without leaking into the Northline tenant.

/* -------------------------------------------------------------------------- */
/* Outbound actions (v0.2)                                                     */
/* -------------------------------------------------------------------------- */

create table if not exists outbound_actions (
  id                  text primary key,
  org_id              text not null references organizations(id) on delete cascade,
  channel             text not null check (channel in ('whatsapp','email','webhook')),
  provider            text not null,
  to_recipient        text not null,
  subject             text,
  body                text not null,
  request_id          text references requests(id) on delete set null,
  lead_id             text,
  external_message_id text,
  status              text not null default 'draft'
                        check (status in ('draft','pending_approval','approved','rejected','sending','sent','failed')),
  error_message       text,
  dedupe_key          text not null,
  created_by          text not null,
  approved_by         text,
  approved_by_label   text,
  approved_at         timestamptz,
  approval_note       text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Provider delivery idempotency: a send that succeeded already cannot be triggered
  -- twice without an explicit reset, and the (org, channel, dedupe_key) triplet is the
  -- guard that webhook redeliveries never create a duplicate.
  unique (org_id, channel, dedupe_key)
);
create index if not exists outbound_actions_org_status_idx on outbound_actions(org_id, status);
create index if not exists outbound_actions_org_request_idx on outbound_actions(org_id, request_id);
create index if not exists outbound_actions_org_external_idx on outbound_actions(org_id, external_message_id);

-- Append-only audit of every state transition on an outbound action. The row in
-- `outbound_actions` is the live state; this table is the trail. Necessary because the
-- existing `audit_events` table records actor + action as a free-form pair, whereas here we
-- want both the previous and the next status plus any provider-specific error blob.
create table if not exists outbound_action_events (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  action_id    text not null references outbound_actions(id) on delete cascade,
  from_status  text,
  to_status    text not null,
  actor_kind   text not null check (actor_kind in ('user','agent','system')),
  actor_id     text not null,
  actor_label  text not null,
  note         text,
  error_code   text,
  error_title  text,
  error_body   text,
  created_at   timestamptz not null default now()
);
create index if not exists outbound_action_events_action_idx on outbound_action_events(action_id, created_at);

/* -------------------------------------------------------------------------- */
/* Business catalog (Retail Bakery demo)                                       */
/* -------------------------------------------------------------------------- */

-- A flat product/FAQ/hours catalog owned by a tenant, used to ground AI replies without
-- pulling in a vector store. Kept intentionally small: the demo is "do these have chocolate
-- cake?", not "semantic search across 50k SKUs".
create table if not exists products (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  name         text not null,
  description  text,
  price_cents  integer,
  currency     text not null default 'USD',
  in_stock     boolean not null default true,
  category     text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists products_org_idx on products(org_id);

create table if not exists faqs (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  question     text not null,
  answer       text not null,
  tags         text[] not null default '{}',
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists faqs_org_idx on faqs(org_id, sort_order);

create table if not exists business_hours (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  timezone     text not null default 'UTC',
  -- Seven rows per org (one per weekday). Plain text keeps the demo readable.
  weekday      text not null check (weekday in ('mon','tue','wed','thu','fri','sat','sun')),
  is_closed    boolean not null default false,
  open_time    text,
  close_time   text,
  unique (org_id, weekday)
);

/* -------------------------------------------------------------------------- */
/* Lead / CRM (v0.2 — used by both WhatsApp Demo A and Lead Management flow)    */
/* -------------------------------------------------------------------------- */

create table if not exists leads (
  id              text primary key,
  org_id          text not null references organizations(id) on delete cascade,
  source          text not null check (source in ('whatsapp','email','manual','webhook')),
  contact_name    text,
  contact_channel text not null,           -- phone number, email, ...
  contact_meta    jsonb not null default '{}'::jsonb,
  intent          text,
  intent_label    text,
  status          text not null default 'new'
                    check (status in ('new','contacted','qualified','won','lost','archived')),
  notes           text,
  request_id      text references requests(id) on delete set null,
  task_id         text references tasks(id) on delete set null,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists leads_org_status_idx on leads(org_id, status);
create index if not exists leads_org_contact_idx on leads(org_id, contact_channel);

do $$
begin
  if to_regprocedure('flowpilot_current_org()') is not null then
    alter table outbound_actions enable row level security;
    drop policy if exists outbound_actions_org_isolation on outbound_actions;
    create policy outbound_actions_org_isolation on outbound_actions
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());

    alter table outbound_action_events enable row level security;
    drop policy if exists outbound_action_events_org_isolation on outbound_action_events;
    create policy outbound_action_events_org_isolation on outbound_action_events
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());

    alter table products enable row level security;
    drop policy if exists products_org_isolation on products;
    create policy products_org_isolation on products
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());

    alter table faqs enable row level security;
    drop policy if exists faqs_org_isolation on faqs;
    create policy faqs_org_isolation on faqs
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());

    alter table business_hours enable row level security;
    drop policy if exists business_hours_org_isolation on business_hours;
    create policy business_hours_org_isolation on business_hours
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());

    alter table leads enable row level security;
    drop policy if exists leads_org_isolation on leads;
    create policy leads_org_isolation on leads
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());
  end if;
end;
$$;
