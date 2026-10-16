-- FlowPilot v0.1 initial schema.
--
-- Portability notes:
--  * IDs are prefixed text ids (tsk_…, req_…), not uuids, so a row stays readable in logs.
--  * Enum-like columns are `text` + CHECK rather than CREATE TYPE: adding a value later is then
--    an ordinary constraint change instead of a type migration, and it behaves identically on
--    Supabase, RDS and PGlite.
--  * Every tenant table carries `org_id` and is indexed by it. That is the physical half of
--    organization isolation; the repository layer is the logical half.

create table if not exists organizations (
  id          text primary key,
  name        text not null,
  slug        text not null unique,
  timezone    text not null default 'UTC',
  created_at  timestamptz not null default now()
);

create table if not exists users (
  id          text primary key,
  email       text not null unique,
  full_name   text not null,
  title       text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

-- Local Auth provider only.
--
-- Supabase Auth owns credentials in its own schema and this table stays empty there. It exists so
-- the local provider has somewhere to keep a password hash instead of bolting one onto `users`,
-- which would make the swap to Supabase Auth a migration instead of a config change.
create table if not exists local_credentials (
  user_id       text primary key references users(id) on delete cascade,
  password_hash text not null,
  password_salt text not null,
  updated_at    timestamptz not null default now()
);

create table if not exists memberships (
  id                     text primary key,
  org_id                 text not null references organizations(id) on delete cascade,
  user_id                text not null references users(id) on delete cascade,
  role                   text not null check (role in ('owner','admin','manager','member')),
  title                  text,
  weekly_capacity_hours  numeric(5,2) not null default 40,
  created_at             timestamptz not null default now(),
  unique (org_id, user_id)
);

create table if not exists clients (
  id            text primary key,
  org_id        text not null references organizations(id) on delete cascade,
  name          text not null,
  industry      text,
  contact_name  text,
  contact_email text,
  status        text not null default 'active' check (status in ('active','prospect','archived')),
  created_at    timestamptz not null default now()
);
create index if not exists clients_org_idx on clients(org_id);

create table if not exists projects (
  id          text primary key,
  org_id      text not null references organizations(id) on delete cascade,
  client_id   text not null references clients(id) on delete cascade,
  name        text not null,
  code        text not null,
  description text,
  status      text not null default 'active' check (status in ('active','on_hold','completed','archived')),
  due_date    date,
  created_at  timestamptz not null default now(),
  unique (org_id, code)
);
create index if not exists projects_org_idx on projects(org_id);

create table if not exists requests (
  id               text primary key,
  org_id           text not null references organizations(id) on delete cascade,
  source           text not null check (source in ('email','manual')),
  source_ref       text not null,
  external_id      text not null,
  client_id        text references clients(id) on delete set null,
  project_id       text references projects(id) on delete set null,
  raw_from         text not null,
  raw_subject      text not null,
  raw_body         text not null,
  raw_received_at  timestamptz not null,
  status           text not null default 'new'
                     check (status in ('new','analyzed','drafted','approved','rejected','failed')),
  analysis         jsonb,
  created_at       timestamptz not null default now(),
  -- Idempotency: the same provider message can never create two requests.
  unique (org_id, source_ref, external_id)
);
create index if not exists requests_org_status_idx on requests(org_id, status);

create table if not exists tasks (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  project_id   text not null references projects(id) on delete cascade,
  request_id   text references requests(id) on delete set null,
  title        text not null,
  description  text,
  status       text not null default 'draft'
                 check (status in ('draft','pending_approval','ready','in_progress','in_review','completed','rejected','cancelled')),
  priority     text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assignee_id  text references users(id) on delete set null,
  due_date     date,
  source       text not null default 'human' check (source in ('human','agent','system')),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      integer not null default 1
);
create index if not exists tasks_org_status_idx on tasks(org_id, status);
create index if not exists tasks_org_assignee_idx on tasks(org_id, assignee_id);
create index if not exists tasks_request_idx on tasks(request_id);

create table if not exists workflow_runs (
  id          text primary key,
  org_id      text not null references organizations(id) on delete cascade,
  request_id  text references requests(id) on delete set null,
  task_id     text references tasks(id) on delete set null,
  trigger     text not null check (trigger in ('mock_email','manual','mcp','system')),
  status      text not null check (status in ('running','waiting_approval','succeeded','failed')),
  steps       jsonb not null default '[]'::jsonb,
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists workflow_runs_org_idx on workflow_runs(org_id, started_at desc);

create table if not exists approvals (
  id               text primary key,
  org_id           text not null references organizations(id) on delete cascade,
  task_id          text not null references tasks(id) on delete cascade,
  request_id       text references requests(id) on delete set null,
  decision         text not null check (decision in ('approved','rejected')),
  note             text,
  decided_by       text not null,
  decided_by_label text not null,
  created_at       timestamptz not null default now()
);
create index if not exists approvals_task_idx on approvals(task_id);
create index if not exists approvals_org_idx on approvals(org_id, created_at desc);

create table if not exists integration_connections (
  id             text primary key,
  org_id         text not null references organizations(id) on delete cascade,
  provider       text not null,
  status         text not null default 'disconnected'
                   check (status in ('connected','disconnected','error')),
  config         jsonb not null default '{}'::jsonb,
  last_event_at  timestamptz,
  created_at     timestamptz not null default now(),
  unique (org_id, provider)
);

-- Only the SHA-256 hash of an agent token is stored. The plaintext is shown once at creation.
create table if not exists agent_credentials (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  name         text not null,
  token_prefix text not null,
  token_hash   text not null unique,
  scopes       text[] not null,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists agent_credentials_org_idx on agent_credentials(org_id);

create table if not exists audit_events (
  id          text primary key,
  org_id      text not null references organizations(id) on delete cascade,
  actor_kind  text not null check (actor_kind in ('user','agent','system')),
  actor_id    text not null,
  actor_label text not null,
  action      text not null,
  entity_type text not null,
  entity_id   text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_events_org_idx on audit_events(org_id, created_at desc);
create index if not exists audit_events_entity_idx on audit_events(org_id, entity_type, entity_id);
