-- Jarvis Hub Phase 3 — Sync & Rules Schema
-- Tables: users, connected_accounts, emails, slack_messages,
--         calendar_events, personal_routines, priority_rules
-- All RLS-scoped by auth.uid().

set search_path = public;

-- =========================================================
-- 1. Helper function: bump updated_at on row update
-- =========================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;


-- =========================================================
-- 2. users — mirror of auth.users with app-level profile
-- =========================================================
create table if not exists public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  full_name     text,
  avatar_url    text,
  timezone      text not null default 'UTC',
  preferences   jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.users enable row level security;

drop trigger if exists users_updated_at on public.users;
create trigger users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

drop policy if exists "users: select own" on public.users;
create policy "users: select own" on public.users
  for select using (auth.uid() = id);

drop policy if exists "users: insert own" on public.users;
create policy "users: insert own" on public.users
  for insert with check (auth.uid() = id);

drop policy if exists "users: update own" on public.users;
create policy "users: update own" on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "users: delete own" on public.users;
create policy "users: delete own" on public.users
  for delete using (auth.uid() = id);


-- =========================================================
-- 3. connected_accounts — OAuth tokens per provider
-- =========================================================
create table if not exists public.connected_accounts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.users(id) on delete cascade,
  provider              text not null,
  provider_account_id   text,
  access_token          text,
  refresh_token         text,
  token_expires_at      timestamptz,
  scopes                text[],
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, provider)
);

alter table public.connected_accounts enable row level security;

drop trigger if exists connected_accounts_updated_at on public.connected_accounts;
create trigger connected_accounts_updated_at
  before update on public.connected_accounts
  for each row execute function public.set_updated_at();

drop policy if exists "connected_accounts: select own" on public.connected_accounts;
create policy "connected_accounts: select own" on public.connected_accounts
  for select using (auth.uid() = user_id);

drop policy if exists "connected_accounts: insert own" on public.connected_accounts;
create policy "connected_accounts: insert own" on public.connected_accounts
  for insert with check (auth.uid() = user_id);

drop policy if exists "connected_accounts: update own" on public.connected_accounts;
create policy "connected_accounts: update own" on public.connected_accounts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "connected_accounts: delete own" on public.connected_accounts;
create policy "connected_accounts: delete own" on public.connected_accounts
  for delete using (auth.uid() = user_id);


-- =========================================================
-- 4. emails — Gmail / Outlook sync
-- =========================================================
create table if not exists public.emails (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  account_id      uuid references public.connected_accounts(id) on delete set null,
  message_id      text not null,
  thread_id       text,
  subject         text,
  from_address    text,
  to_addresses    text[],
  cc_addresses    text[],
  snippet         text,
  body_text       text,
  body_html       text,
  labels          text[],
  is_read         boolean not null default false,
  is_starred      boolean not null default false,
  is_archived     boolean not null default false,
  received_at     timestamptz,
  raw_metadata    jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, message_id)
);

alter table public.emails enable row level security;

drop trigger if exists emails_updated_at on public.emails;
create trigger emails_updated_at
  before update on public.emails
  for each row execute function public.set_updated_at();

create index if not exists emails_user_id_idx
  on public.emails (user_id);
create index if not exists emails_received_at_idx
  on public.emails (user_id, received_at desc);
create index if not exists emails_thread_id_idx
  on public.emails (user_id, thread_id);

drop policy if exists "emails: select own" on public.emails;
create policy "emails: select own" on public.emails
  for select using (auth.uid() = user_id);

drop policy if exists "emails: insert own" on public.emails;
create policy "emails: insert own" on public.emails
  for insert with check (auth.uid() = user_id);

drop policy if exists "emails: update own" on public.emails;
create policy "emails: update own" on public.emails
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "emails: delete own" on public.emails;
create policy "emails: delete own" on public.emails
  for delete using (auth.uid() = user_id);


-- =========================================================
-- 5. slack_messages — per workspace+channel+ts
-- =========================================================
create table if not exists public.slack_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  account_id      uuid references public.connected_accounts(id) on delete set null,
  workspace_id    text not null,
  workspace_name  text,
  channel_id      text not null,
  channel_name    text,
  message_ts      text not null,
  thread_ts       text,
  sender_id       text,
  sender_name     text,
  text            text,
  attachments     jsonb not null default '[]'::jsonb,
  reactions       jsonb not null default '[]'::jsonb,
  is_mention      boolean not null default false,
  is_dm           boolean not null default false,
  raw_metadata    jsonb not null default '{}'::jsonb,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, workspace_id, channel_id, message_ts)
);

alter table public.slack_messages enable row level security;

drop trigger if exists slack_messages_updated_at on public.slack_messages;
create trigger slack_messages_updated_at
  before update on public.slack_messages
  for each row execute function public.set_updated_at();

create index if not exists slack_messages_user_id_idx
  on public.slack_messages (user_id);
create index if not exists slack_messages_sent_at_idx
  on public.slack_messages (user_id, sent_at desc);
create index if not exists slack_messages_channel_idx
  on public.slack_messages (user_id, workspace_id, channel_id);
create index if not exists slack_messages_mention_idx
  on public.slack_messages (user_id, is_mention)
  where is_mention = true;

drop policy if exists "slack_messages: select own" on public.slack_messages;
create policy "slack_messages: select own" on public.slack_messages
  for select using (auth.uid() = user_id);

drop policy if exists "slack_messages: insert own" on public.slack_messages;
create policy "slack_messages: insert own" on public.slack_messages
  for insert with check (auth.uid() = user_id);

drop policy if exists "slack_messages: update own" on public.slack_messages;
create policy "slack_messages: update own" on public.slack_messages
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "slack_messages: delete own" on public.slack_messages;
create policy "slack_messages: delete own" on public.slack_messages
  for delete using (auth.uid() = user_id);


-- =========================================================
-- 6. calendar_events — Google Calendar
-- =========================================================
create table if not exists public.calendar_events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  account_id        uuid references public.connected_accounts(id) on delete set null,
  event_id          text not null,
  calendar_id       text,
  title             text,
  description       text,
  location          text,
  start_at          timestamptz not null,
  end_at            timestamptz not null,
  is_all_day        boolean not null default false,
  status            text not null default 'confirmed',
  organizer_email   text,
  attendees         jsonb not null default '[]'::jsonb,
  recurrence        text[],
  conference_url    text,
  raw_metadata      jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, event_id)
);

alter table public.calendar_events enable row level security;

drop trigger if exists calendar_events_updated_at on public.calendar_events;
create trigger calendar_events_updated_at
  before update on public.calendar_events
  for each row execute function public.set_updated_at();

create index if not exists calendar_events_user_id_idx
  on public.calendar_events (user_id);
create index if not exists calendar_events_start_at_idx
  on public.calendar_events (user_id, start_at);
create index if not exists calendar_events_range_idx
  on public.calendar_events (user_id, start_at, end_at);

drop policy if exists "calendar_events: select own" on public.calendar_events;
create policy "calendar_events: select own" on public.calendar_events
  for select using (auth.uid() = user_id);

drop policy if exists "calendar_events: insert own" on public.calendar_events;
create policy "calendar_events: insert own" on public.calendar_events
  for insert with check (auth.uid() = user_id);

drop policy if exists "calendar_events: update own" on public.calendar_events;
create policy "calendar_events: update own" on public.calendar_events
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "calendar_events: delete own" on public.calendar_events;
create policy "calendar_events: delete own" on public.calendar_events
  for delete using (auth.uid() = user_id);


-- =========================================================
-- 7. personal_routines — cron + trigger_config
-- =========================================================
create table if not exists public.personal_routines (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  name              text not null,
  description       text,
  trigger_type      text not null default 'schedule',
  cron_expression   text,
  trigger_config    jsonb not null default '{}'::jsonb,
  actions           jsonb not null default '[]'::jsonb,
  is_active         boolean not null default true,
  last_run_at       timestamptz,
  next_run_at       timestamptz,
  run_count         integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.personal_routines enable row level security;

drop trigger if exists personal_routines_updated_at on public.personal_routines;
create trigger personal_routines_updated_at
  before update on public.personal_routines
  for each row execute function public.set_updated_at();

create index if not exists personal_routines_user_id_idx
  on public.personal_routines (user_id);
create index if not exists personal_routines_next_run_idx
  on public.personal_routines (next_run_at)
  where is_active = true;

drop policy if exists "personal_routines: select own" on public.personal_routines;
create policy "personal_routines: select own" on public.personal_routines
  for select using (auth.uid() = user_id);

drop policy if exists "personal_routines: insert own" on public.personal_routines;
create policy "personal_routines: insert own" on public.personal_routines
  for insert with check (auth.uid() = user_id);

drop policy if exists "personal_routines: update own" on public.personal_routines;
create policy "personal_routines: update own" on public.personal_routines
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "personal_routines: delete own" on public.personal_routines;
create policy "personal_routines: delete own" on public.personal_routines
  for delete using (auth.uid() = user_id);


-- =========================================================
-- 8. priority_rules — conditions + score 0-100
-- =========================================================
create table if not exists public.priority_rules (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  name            text not null,
  description     text,
  source_type     text not null,
  conditions      jsonb not null default '[]'::jsonb,
  priority_score  integer not null default 50
                  check (priority_score >= 0 and priority_score <= 100),
  action_tags     text[],
  notify          boolean not null default true,
  is_active       boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.priority_rules enable row level security;

drop trigger if exists priority_rules_updated_at on public.priority_rules;
create trigger priority_rules_updated_at
  before update on public.priority_rules
  for each row execute function public.set_updated_at();

create index if not exists priority_rules_user_id_idx
  on public.priority_rules (user_id);
create index if not exists priority_rules_active_idx
  on public.priority_rules (user_id, is_active, sort_order)
  where is_active = true;

drop policy if exists "priority_rules: select own" on public.priority_rules;
create policy "priority_rules: select own" on public.priority_rules
  for select using (auth.uid() = user_id);

drop policy if exists "priority_rules: insert own" on public.priority_rules;
create policy "priority_rules: insert own" on public.priority_rules
  for insert with check (auth.uid() = user_id);

drop policy if exists "priority_rules: update own" on public.priority_rules;
create policy "priority_rules: update own" on public.priority_rules
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "priority_rules: delete own" on public.priority_rules;
create policy "priority_rules: delete own" on public.priority_rules
  for delete using (auth.uid() = user_id);
