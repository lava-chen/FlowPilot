-- Organization-owned AI provider settings. API keys are encrypted by Core before persistence.
create table if not exists ai_provider_settings (
  org_id              text primary key references organizations(id) on delete cascade,
  provider            text not null check (provider in ('deterministic','openai-compatible')),
  base_url            text,
  model               text,
  api_key_ciphertext  text,
  api_key_iv          text,
  api_key_auth_tag    text,
  updated_by          text not null references users(id) on delete restrict,
  updated_at          timestamptz not null default now(),
  check (
    (provider = 'deterministic' and base_url is null and model is null and api_key_ciphertext is null and api_key_iv is null and api_key_auth_tag is null)
    or
    (provider = 'openai-compatible' and base_url is not null and model is not null and api_key_ciphertext is not null and api_key_iv is not null and api_key_auth_tag is not null)
  )
);

do $$
begin
  if to_regprocedure('flowpilot_current_org()') is not null then
    alter table ai_provider_settings enable row level security;
    drop policy if exists ai_provider_settings_org_isolation on ai_provider_settings;
    create policy ai_provider_settings_org_isolation on ai_provider_settings
      using (org_id = flowpilot_current_org())
      with check (org_id = flowpilot_current_org());
  end if;
end;
$$;
