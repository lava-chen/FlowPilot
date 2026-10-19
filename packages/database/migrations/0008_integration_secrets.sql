-- Integration Hardening — encrypted storage for non-OAuth provider credentials.
--
-- Why this is its own table rather than a field on `integration_connections.config`:
--   - `config` is echoed back to the dashboard UI. Secrets must never travel through a code
--     path that renders to a browser, so they get a table that only server-side resolvers read.
--   - Each secret gets its own row keyed by `secret_name`, so `whatsapp-cloud` can hold an
--     access token and an app secret with independent AES-GCM contexts (see `SecretContext`
--     in `packages/core/src/ai/settings-crypto.ts`). Compromising one row reveals nothing
--     about the other.
--   - Rotating a secret is an upsert on one row, not a read-modify-write of a JSON blob that
--     two concurrent dashboard saves could clobber.
--
-- This is deliberately the same shape as `oauth_tokens` (0007) so the two secret stores have
-- one mental model: ciphertext + iv + auth_tag per secret, never plaintext.

create table if not exists integration_secrets (
  org_id       text not null references organizations(id) on delete cascade,
  provider     text not null,
  -- Free-form discriminator within the provider: 'access_token', 'app_secret', ...
  secret_name  text not null,
  -- AES-256-GCM. Each `secret_name` is encrypted under its own derived key, so the columns
  -- here are interchangeable without weakening domain separation.
  ciphertext   text not null,
  iv           text not null,
  auth_tag     text not null,
  -- Set when the provider reports the credential is no longer usable, so the dashboard can
  -- show "reconnect" instead of silently failing on every send.
  invalidated_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (org_id, provider, secret_name)
);

create index if not exists integration_secrets_provider_idx
  on integration_secrets(org_id, provider);

do $$
begin
  if to_regprocedure('flowpilot_current_org()') is not null then
    alter table integration_secrets enable row level security;
    drop policy if exists integration_secrets_org_isolation on integration_secrets;
    create policy integration_secrets_org_isolation on integration_secrets
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());
  end if;
end;
$$;
