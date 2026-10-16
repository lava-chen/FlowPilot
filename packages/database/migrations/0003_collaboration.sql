-- FlowPilot task coordination and client sign-off.
-- Forward-only: v0.1 migrations are already applied in local demo databases.

alter table tasks
  add column if not exists estimated_hours numeric(6,2)
    check (estimated_hours is null or (estimated_hours >= 0 and estimated_hours <= 10000));

create table if not exists task_checklist_items (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  task_id      text not null references tasks(id) on delete cascade,
  title        text not null,
  is_complete  boolean not null default false,
  sort_order   integer not null default 0,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists task_checklist_task_idx on task_checklist_items(org_id, task_id, sort_order, created_at);

create table if not exists task_comments (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  task_id      text not null references tasks(id) on delete cascade,
  author_id    text not null,
  author_label text not null,
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists task_comments_task_idx on task_comments(org_id, task_id, created_at desc);

create table if not exists task_links (
  id         text primary key,
  org_id     text not null references organizations(id) on delete cascade,
  task_id    text not null references tasks(id) on delete cascade,
  label      text not null,
  url        text not null,
  kind       text not null check (kind in ('brief','reference','delivery','other')),
  added_by   text not null,
  created_at timestamptz not null default now()
);
create index if not exists task_links_task_idx on task_links(org_id, task_id, created_at desc);

create table if not exists task_time_entries (
  id          text primary key,
  org_id      text not null references organizations(id) on delete cascade,
  task_id     text not null references tasks(id) on delete cascade,
  user_id     text not null references users(id) on delete restrict,
  description text,
  hours       numeric(6,2) not null check (hours > 0 and hours <= 24),
  logged_on   date not null default current_date,
  created_at  timestamptz not null default now()
);
create index if not exists task_time_task_idx on task_time_entries(org_id, task_id, logged_on desc);
create index if not exists task_time_user_idx on task_time_entries(org_id, user_id, logged_on desc);

create table if not exists task_dependencies (
  id                  text primary key,
  org_id              text not null references organizations(id) on delete cascade,
  task_id             text not null references tasks(id) on delete cascade,
  depends_on_task_id  text not null references tasks(id) on delete cascade,
  created_at          timestamptz not null default now(),
  check (task_id <> depends_on_task_id),
  unique (org_id, task_id, depends_on_task_id)
);
create index if not exists task_dependencies_task_idx on task_dependencies(org_id, task_id);
create index if not exists task_dependencies_predecessor_idx on task_dependencies(org_id, depends_on_task_id);

create table if not exists task_client_reviews (
  id            text primary key,
  org_id        text not null references organizations(id) on delete cascade,
  task_id       text not null references tasks(id) on delete cascade,
  token_hash    text not null unique,
  status        text not null check (status in ('pending','approved','changes_requested','expired')),
  requested_by  text not null,
  reviewer_name text,
  reviewer_email text,
  note          text,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  responded_at  timestamptz
);
create index if not exists task_client_reviews_task_idx on task_client_reviews(org_id, task_id, created_at desc);
create index if not exists task_client_reviews_pending_idx on task_client_reviews(task_id, status, expires_at);
create unique index if not exists task_client_reviews_one_pending_idx on task_client_reviews(task_id) where status = 'pending';

-- Extend the optional RLS setup when migration 0002 has been enabled. The default local owner
-- path remains unchanged; on tenant-scoped database roles the new tables follow the same policy.
do $$
declare
  t text;
begin
  if to_regprocedure('flowpilot_current_org()') is not null then
    foreach t in array array[
      'task_checklist_items','task_comments','task_links','task_time_entries','task_dependencies','task_client_reviews'
    ] loop
      execute format('alter table %I enable row level security', t);
      execute format('drop policy if exists %I on %I', t || '_org_isolation', t);
      execute format(
        'create policy %I on %I using (org_id = flowpilot_current_org()) with check (org_id = flowpilot_current_org())',
        t || '_org_isolation', t
      );
    end loop;
  end if;
end;
$$;
