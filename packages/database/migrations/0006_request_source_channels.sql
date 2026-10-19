-- Add 'whatsapp' to the `requests.source` check constraint so the inbox can distinguish
-- WhatsApp-sourced requests from email/manual ones without parsing the raw `from` field.
--
-- Inline-upsert: PGlite and PostgreSQL both support dropping + recreating CHECK constraints
-- without rebuilding the table, so this is safe to apply against a database that already
-- contains `source = 'email'` rows.

alter table requests drop constraint if exists requests_source_check;
alter table requests
  add constraint requests_source_check
  check (source in ('email','manual','whatsapp'));
