-- ODIN memory and conversation continuity.
-- Durable memory is explicit/manual by default. Raw Slack/Gmail bodies are not stored here.

set search_path = public;

create table if not exists public.odin_memories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  kind        text not null default 'other'
              check (kind in ('preference', 'business', 'person', 'tone', 'priority', 'routine', 'source', 'other')),
  title       text not null,
  content     text not null,
  source      text not null default 'manual'
              check (source in ('manual', 'odin', 'system')),
  confidence  numeric not null default 1
              check (confidence >= 0 and confidence <= 1),
  status      text not null default 'active'
              check (status in ('active', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.odin_memories enable row level security;

drop trigger if exists odin_memories_updated_at on public.odin_memories;
create trigger odin_memories_updated_at
  before update on public.odin_memories
  for each row execute function public.set_updated_at();

create index if not exists odin_memories_user_status_idx
  on public.odin_memories(user_id, status, kind, updated_at desc);

drop policy if exists "odin_memories: select own" on public.odin_memories;
create policy "odin_memories: select own" on public.odin_memories
  for select using (auth.uid() = user_id);

drop policy if exists "odin_memories: insert own" on public.odin_memories;
create policy "odin_memories: insert own" on public.odin_memories
  for insert with check (auth.uid() = user_id);

drop policy if exists "odin_memories: update own" on public.odin_memories;
create policy "odin_memories: update own" on public.odin_memories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "odin_memories: delete own" on public.odin_memories;
create policy "odin_memories: delete own" on public.odin_memories
  for delete using (auth.uid() = user_id);

create table if not exists public.odin_conversation_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  conversation_id text,
  turn_id         text,
  source          text not null default 'text'
                  check (source in ('voice', 'text', 'tool', 'system')),
  role            text not null
                  check (role in ('user', 'assistant', 'tool', 'system')),
  mode            text,
  content         text not null default '',
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

alter table public.odin_conversation_events enable row level security;

create index if not exists odin_conversation_events_user_conversation_idx
  on public.odin_conversation_events(user_id, conversation_id, created_at desc);

create index if not exists odin_conversation_events_user_created_idx
  on public.odin_conversation_events(user_id, created_at desc);

drop policy if exists "odin_conversation_events: select own" on public.odin_conversation_events;
create policy "odin_conversation_events: select own" on public.odin_conversation_events
  for select using (auth.uid() = user_id);

drop policy if exists "odin_conversation_events: insert own" on public.odin_conversation_events;
create policy "odin_conversation_events: insert own" on public.odin_conversation_events
  for insert with check (auth.uid() = user_id);

drop policy if exists "odin_conversation_events: update own" on public.odin_conversation_events;
create policy "odin_conversation_events: update own" on public.odin_conversation_events
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "odin_conversation_events: delete own" on public.odin_conversation_events;
create policy "odin_conversation_events: delete own" on public.odin_conversation_events
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.odin_memories to authenticated;
grant select, insert, update, delete on public.odin_conversation_events to authenticated;
