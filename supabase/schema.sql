-- PSO North Region Site Map — Supabase schema.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query) before setting SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY on the
-- server. Each JSON file the app used to keep in data/ maps onto one of
-- these tables, so no other backend code needs to change if the app's
-- field set changes later — the "data"/"value" column carries the whole
-- record as jsonb, same shape as the JSON file it replaces.
--
-- The server only ever talks to these tables using the service_role key,
-- which bypasses Row Level Security entirely — so no RLS policies are
-- needed here. That key must stay a server-side env var only; never expose
-- it to the browser.

create table if not exists outlets (
  code bigint primary key,
  data jsonb not null
);

create table if not exists facilities (
  code text primary key,
  data jsonb not null default '{}'::jsonb
);

-- One row each for categories.json, column-config.json and
-- custom-columns.json (see lib/supabaseStore.js for the key names).
create table if not exists app_config (
  key text primary key,
  value jsonb not null
);
