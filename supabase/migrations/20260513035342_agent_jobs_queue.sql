set search_path = public;

create table if not exists public.agent_jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  type         text not null,
  status       text not null default 'queued',
  input        jsonb not null default '{}'::jsonb,
  result       jsonb,
  error        text,
  worker_id    text,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint agent_jobs_type_check check (
    type in ('slack_browser_scan', 'gmail_browser_scan', 'combined_doo_scan')
  ),
  constraint agent_jobs_status_check check (
    status in ('queued', 'running', 'completed', 'failed', 'login_required', 'cancelled')
  )
);

alter table public.agent_jobs enable row level security;

drop trigger if exists agent_jobs_updated_at on public.agent_jobs;
create trigger agent_jobs_updated_at
  before update on public.agent_jobs
  for each row execute function public.set_updated_at();

create index if not exists agent_jobs_user_created_idx
  on public.agent_jobs (user_id, created_at desc);

create index if not exists agent_jobs_worker_queue_idx
  on public.agent_jobs (status, created_at)
  where status in ('queued', 'running');

drop policy if exists "agent_jobs: select own" on public.agent_jobs;
create policy "agent_jobs: select own" on public.agent_jobs
  for select using (auth.uid() = user_id);

drop policy if exists "agent_jobs: insert own" on public.agent_jobs;
create policy "agent_jobs: insert own" on public.agent_jobs
  for insert with check (auth.uid() = user_id);

drop policy if exists "agent_jobs: update own" on public.agent_jobs;
create policy "agent_jobs: update own" on public.agent_jobs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "agent_jobs: delete own" on public.agent_jobs;
create policy "agent_jobs: delete own" on public.agent_jobs
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on table public.agent_jobs to authenticated;
