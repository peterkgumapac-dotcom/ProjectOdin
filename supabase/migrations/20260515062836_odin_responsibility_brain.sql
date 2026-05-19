-- ODIN responsibility brain.
-- Stores cached manual scans, persistent pending work, and automatic learning audit events.

set search_path = public;

create table if not exists public.odin_scan_snapshots (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  source          text not null
                  check (source in ('gmail', 'slack', 'calendar', 'health', 'browser')),
  status          text not null default 'ok'
                  check (status in ('ok', 'partial', 'failed')),
  summary         text not null default '',
  payload         jsonb not null default '{}'::jsonb,
  signal_count    integer not null default 0
                  check (signal_count >= 0),
  window_days     integer
                  check (window_days is null or window_days > 0),
  warnings        text[] not null default '{}',
  scanned_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, source)
);

alter table public.odin_scan_snapshots enable row level security;

drop trigger if exists odin_scan_snapshots_updated_at on public.odin_scan_snapshots;
create trigger odin_scan_snapshots_updated_at
  before update on public.odin_scan_snapshots
  for each row execute function public.set_updated_at();

create index if not exists odin_scan_snapshots_user_scanned_idx
  on public.odin_scan_snapshots(user_id, scanned_at desc);

drop policy if exists "odin_scan_snapshots: select own" on public.odin_scan_snapshots;
create policy "odin_scan_snapshots: select own" on public.odin_scan_snapshots
  for select using (auth.uid() = user_id);

drop policy if exists "odin_scan_snapshots: insert own" on public.odin_scan_snapshots;
create policy "odin_scan_snapshots: insert own" on public.odin_scan_snapshots
  for insert with check (auth.uid() = user_id);

drop policy if exists "odin_scan_snapshots: update own" on public.odin_scan_snapshots;
create policy "odin_scan_snapshots: update own" on public.odin_scan_snapshots
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "odin_scan_snapshots: delete own" on public.odin_scan_snapshots;
create policy "odin_scan_snapshots: delete own" on public.odin_scan_snapshots
  for delete using (auth.uid() = user_id);

create table if not exists public.odin_pending_items (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  source          text not null
                  check (source in ('gmail', 'slack', 'calendar', 'health', 'browser', 'manual', 'memory', 'research', 'system')),
  source_item_id  text not null,
  business        text,
  person          text,
  title           text not null,
  summary         text not null default '',
  urgency         text not null default 'medium'
                  check (urgency in ('critical', 'high', 'medium', 'low')),
  bucket          text not null default 'needs_peter'
                  check (bucket in ('needs_peter', 'waiting_on_others', 'today', 'done_recently')),
  status          text not null default 'open'
                  check (status in ('open', 'handled', 'deferred', 'waiting')),
  evidence_url    text,
  evidence_label  text,
  next_action     text,
  suggested_reply text,
  due_at          timestamptz,
  last_seen_at    timestamptz not null default now(),
  resolved_at     timestamptz,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, source, source_item_id)
);

alter table public.odin_pending_items enable row level security;

drop trigger if exists odin_pending_items_updated_at on public.odin_pending_items;
create trigger odin_pending_items_updated_at
  before update on public.odin_pending_items
  for each row execute function public.set_updated_at();

create index if not exists odin_pending_items_user_bucket_idx
  on public.odin_pending_items(user_id, bucket, status, updated_at desc);

create index if not exists odin_pending_items_user_source_idx
  on public.odin_pending_items(user_id, source, last_seen_at desc);

drop policy if exists "odin_pending_items: select own" on public.odin_pending_items;
create policy "odin_pending_items: select own" on public.odin_pending_items
  for select using (auth.uid() = user_id);

drop policy if exists "odin_pending_items: insert own" on public.odin_pending_items;
create policy "odin_pending_items: insert own" on public.odin_pending_items
  for insert with check (auth.uid() = user_id);

drop policy if exists "odin_pending_items: update own" on public.odin_pending_items;
create policy "odin_pending_items: update own" on public.odin_pending_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "odin_pending_items: delete own" on public.odin_pending_items;
create policy "odin_pending_items: delete own" on public.odin_pending_items
  for delete using (auth.uid() = user_id);

create table if not exists public.odin_learning_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  source_type text not null
              check (source_type in ('conversation', 'post_call', 'manual_scan', 'correction', 'system')),
  source_id   text,
  event_type  text not null
              check (event_type in ('memory', 'rule', 'pending', 'scan', 'correction')),
  summary     text not null,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'applied'
              check (status in ('applied', 'skipped', 'failed', 'archived')),
  created_at  timestamptz not null default now()
);

alter table public.odin_learning_events enable row level security;

create index if not exists odin_learning_events_user_created_idx
  on public.odin_learning_events(user_id, created_at desc);

create index if not exists odin_learning_events_user_status_idx
  on public.odin_learning_events(user_id, status, created_at desc);

drop policy if exists "odin_learning_events: select own" on public.odin_learning_events;
create policy "odin_learning_events: select own" on public.odin_learning_events
  for select using (auth.uid() = user_id);

drop policy if exists "odin_learning_events: insert own" on public.odin_learning_events;
create policy "odin_learning_events: insert own" on public.odin_learning_events
  for insert with check (auth.uid() = user_id);

drop policy if exists "odin_learning_events: update own" on public.odin_learning_events;
create policy "odin_learning_events: update own" on public.odin_learning_events
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "odin_learning_events: delete own" on public.odin_learning_events;
create policy "odin_learning_events: delete own" on public.odin_learning_events
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.odin_scan_snapshots to authenticated;
grant select, insert, update, delete on public.odin_pending_items to authenticated;
grant select, insert, update, delete on public.odin_learning_events to authenticated;
