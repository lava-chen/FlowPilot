-- Row Level Security policies.
--
-- Applied only when FLOWPILOT_ENABLE_RLS=true, because RLS is bypassed for the table owner —
-- enabling it against the same role that created the tables would look secure and secure
-- nothing. Under Supabase the app connects as a non-owner role, which is the intended setup.
--
-- The application already scopes every query by org_id at the repository layer; these policies
-- are the second, independent barrier. Both must agree for a row to be visible.

create or replace function flowpilot_current_org() returns text
language sql stable as $$
  select nullif(current_setting('app.current_org', true), '');
$$;

alter table organizations       enable row level security;
alter table memberships         enable row level security;
alter table clients             enable row level security;
alter table projects            enable row level security;
alter table requests            enable row level security;
alter table tasks               enable row level security;
alter table workflow_runs       enable row level security;
alter table approvals           enable row level security;
alter table integration_connections enable row level security;
alter table agent_credentials   enable row level security;
alter table audit_events        enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'memberships','clients','projects','requests','tasks',
    'workflow_runs','approvals','integration_connections','agent_credentials','audit_events'
  ]
  loop
    execute format('drop policy if exists %I on %I', t || '_org_isolation', t);
    execute format(
      'create policy %I on %I using (org_id = flowpilot_current_org()) with check (org_id = flowpilot_current_org())',
      t || '_org_isolation', t
    );
  end loop;
end;
$$;

-- organizations has no org_id column; scope it by primary key.
drop policy if exists organizations_org_isolation on organizations;
create policy organizations_org_isolation on organizations
  using (id = flowpilot_current_org())
  with check (id = flowpilot_current_org());
