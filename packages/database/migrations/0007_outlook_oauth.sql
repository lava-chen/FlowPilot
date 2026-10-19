-- Phase 2 — Microsoft Outlook (Microsoft Graph) OAuth state + tokens +
-- per-org delta-query sync cursors.
--
-- Why this is its own table rather than extending `integration_connections.config`:
--   - Tokens *must* be encrypted at rest (we never log `refresh_token`). Keeping them
--     on a side table means we can apply column-level encryption policy without
--     affecting the rest of `integration_connections`.
--   - OAuth handshakes in flight (the PKCE verifier) are short-lived but can race
--     between concurrent browser tabs. A dedicated `oauth_states` row keeps the
--     flow single-purpose and easy to garbage-collect.
--   - Delta-sync cursors are read on every inbox check; a sidecar keeps the
--     hot-path query off the `integration_connections` row when secrets get large.

create table if not exists oauth_states (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  provider     text not null,
  -- The state string we signed and bounced through the IdP. Includes the PKCE
  -- verifier (hashed) + the original return path so the callback can route back.
  state        text not null,
  -- Verifier is the secret half of PKCE. Stored as the SHA-256 hash — we don't
  -- need the raw value, only the ability to recompute the challenge.
  code_verifier_hash text not null,
  return_to    text,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists oauth_states_org_idx on oauth_states(org_id, provider, created_at desc);

create table if not exists oauth_tokens (
  org_id            text not null references organizations(id) on delete cascade,
  provider          text not null,
  -- The IdP-visible account this token belongs to (`userPrincipalName`, mail, etc.).
  account_label     text not null,
  -- AES-256-GCM ciphertext for the access token. Refresh token is encrypted separately
  -- so an access-token refresh doesn't have to re-decrypt the refresh token.
  access_ciphertext text not null,
  access_iv         text not null,
  access_auth_tag   text not null,
  refresh_ciphertext text not null,
  refresh_iv         text not null,
  refresh_auth_tag   text not null,
  -- Lifetime advertised by the IdP. Used to schedule refresh.
  access_expires_at timestamptz not null,
  scopes            text[] not null default '{}',
  -- Token-type hint (Bearer) and any extra fields returned by the IdP that the
  -- adapter wants to remember (e.g. `id_token`, `ext_expires_in`).
  extra             jsonb not null default '{}'::jsonb,
  -- Last successful refresh / login timestamp.
  refreshed_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  primary key (org_id, provider)
);

create table if not exists integration_sync_cursors (
  org_id          text not null references organizations(id) on delete cascade,
  provider        text not null,
  cursor_kind     text not null,
  cursor_value    text not null,
  last_synced_at  timestamptz not null default now(),
  total_ingested  bigint not null default 0,
  -- Provider-specific extra metadata (e.g. `@odata.deltaLink` URL vs raw skip token).
  metadata        jsonb not null default '{}'::jsonb,
  primary key (org_id, provider, cursor_kind)
);

do $$
begin
  if to_regprocedure('flowpilot_current_org()') is not null then
    alter table oauth_states enable row level security;
    drop policy if exists oauth_states_org_isolation on oauth_states;
    create policy oauth_states_org_isolation on oauth_states
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());

    alter table oauth_tokens enable row level security;
    drop policy if exists oauth_tokens_org_isolation on oauth_tokens;
    create policy oauth_tokens_org_isolation on oauth_tokens
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());

    alter table integration_sync_cursors enable row level security;
    drop policy if exists integration_sync_cursors_org_isolation on integration_sync_cursors;
    create policy integration_sync_cursors_org_isolation on integration_sync_cursors
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());
  end if;
end;
$$;
