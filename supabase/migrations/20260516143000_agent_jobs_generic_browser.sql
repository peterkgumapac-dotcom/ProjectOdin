set search_path = public;

alter table public.agent_jobs
  drop constraint if exists agent_jobs_type_check;

alter table public.agent_jobs
  add constraint agent_jobs_type_check check (
    type in (
      'slack_browser_scan',
      'gmail_browser_scan',
      'combined_doo_scan',
      'browser_open',
      'browser_observe',
      'browser_agent_task'
    )
  );

alter table public.agent_jobs
  drop constraint if exists agent_jobs_status_check;

alter table public.agent_jobs
  add constraint agent_jobs_status_check check (
    status in (
      'queued',
      'running',
      'completed',
      'failed',
      'login_required',
      'awaiting_confirmation',
      'cancelled'
    )
  );
