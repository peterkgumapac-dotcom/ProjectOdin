-- Phase 5a: persist Jarvis conversation history.
-- Immutable rows (no update policy). Most-recent-first index.

create table if not exists public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant', 'system')),
  content         text not null,
  model           text,
  tokens_input    integer,
  tokens_output   integer,
  created_at      timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

create index if not exists chat_messages_user_created_idx
  on public.chat_messages (user_id, created_at desc);

drop policy if exists "chat_messages: select own" on public.chat_messages;
create policy "chat_messages: select own" on public.chat_messages
  for select using (auth.uid() = user_id);

drop policy if exists "chat_messages: insert own" on public.chat_messages;
create policy "chat_messages: insert own" on public.chat_messages
  for insert with check (auth.uid() = user_id);

drop policy if exists "chat_messages: delete own" on public.chat_messages;
create policy "chat_messages: delete own" on public.chat_messages
  for delete using (auth.uid() = user_id);
