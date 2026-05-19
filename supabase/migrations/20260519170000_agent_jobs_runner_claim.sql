set search_path = public;

alter table public.agent_jobs
  add column if not exists claimed_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists result_count integer not null default 0,
  add column if not exists error_message text;

create index if not exists agent_jobs_claim_queue_idx
  on public.agent_jobs (status, created_at)
  where status = 'queued';

create or replace function public.claim_next_agent_job(p_worker_id text)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.agent_jobs;
begin
  update public.agent_jobs as j
  set
    status = 'running',
    worker_id = p_worker_id,
    locked_by = p_worker_id,
    started_at = coalesce(j.started_at, now()),
    claimed_at = now(),
    completed_at = null,
    error = null,
    error_message = null,
    updated_at = now()
  where j.id in (
    select id
    from public.agent_jobs
    where status = 'queued'
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning * into claimed;

  return claimed;
end;
$$;

grant execute on function public.claim_next_agent_job(text) to service_role;
