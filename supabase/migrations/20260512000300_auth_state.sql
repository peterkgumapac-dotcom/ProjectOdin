-- Phase 6: CSRF state for OAuth handshakes (Google / Slack / Spotify).
-- Rows are short-lived; callback deletes them on consume.

create table if not exists public.auth_state (
  state       text primary key,
  user_id     uuid not null references public.users(id) on delete cascade,
  provider    text not null,
  redirect_to text,
  created_at  timestamptz not null default now()
);

alter table public.auth_state enable row level security;

create index if not exists auth_state_user_id_idx
  on public.auth_state (user_id);
create index if not exists auth_state_created_at_idx
  on public.auth_state (created_at);

drop policy if exists "auth_state: select own" on public.auth_state;
create policy "auth_state: select own" on public.auth_state
  for select using (auth.uid() = user_id);
drop policy if exists "auth_state: insert own" on public.auth_state;
create policy "auth_state: insert own" on public.auth_state
  for insert with check (auth.uid() = user_id);
drop policy if exists "auth_state: delete own" on public.auth_state;
create policy "auth_state: delete own" on public.auth_state
  for delete using (auth.uid() = user_id);
