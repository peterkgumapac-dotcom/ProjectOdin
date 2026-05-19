-- Phase 6.5: Multi-account connector support.
--
-- Replace single (user, provider) constraint with a tuple that lets one user
-- hold many Gmail addresses and many Slack workspaces under the same provider.
-- The label, workflow_rules, and is_primary columns enable per-account UX
-- (Personal/Work tabs) and per-account automation rules.

-- 1. Drop the legacy single-account constraint (named by the original
--    `unique (user_id, provider)` clause in 20260512000000_init_schema.sql).
alter table public.connected_accounts
  drop constraint if exists connected_accounts_user_id_provider_key;

-- 2. Multi-account columns.
alter table public.connected_accounts
  add column if not exists account_email   text,
  add column if not exists account_label   text default 'Account',
  add column if not exists workspace_name  text,
  add column if not exists workspace_id    text,
  add column if not exists workflow_rules  jsonb default '[]'::jsonb,
  add column if not exists is_primary      boolean default false;

-- 3. Seed: existing peterkgumapac@gmail.com Google row gets its identifiers
--    backfilled so the new unique key holds. Idempotent for safety.
update public.connected_accounts
   set account_email = coalesce(account_email, (metadata ->> 'email')),
       account_label = coalesce(nullif(account_label, ''), 'Personal'),
       is_primary    = true
 where provider = 'google'
   and account_email is null;

-- Fallback: if metadata had no email for some reason, use the hardcoded address
-- (matches CLAUDE.md userEmail). Safe to no-op once Phase 6 fix already ran.
update public.connected_accounts
   set account_email = 'peterkgumapac@gmail.com'
 where provider = 'google'
   and account_email is null;

-- 4. Unique on the identifier tuple. NULLS NOT DISTINCT is critical: without it,
--    Postgres treats every NULL as distinct, so two Google rows with the same
--    email but null workspace_id (or two Slack rows with same workspace but null
--    email) would still be allowed -- defeating the whole point.
alter table public.connected_accounts
  add constraint connected_accounts_user_provider_account_key
  unique nulls not distinct (user_id, provider, account_email, workspace_id);

-- 5. Lookups by (user, provider) stay hot.
create index if not exists connected_accounts_user_provider_idx
  on public.connected_accounts (user_id, provider);

-- 6. Carry the per-account label through the OAuth handshake.
alter table public.auth_state
  add column if not exists account_label text;
