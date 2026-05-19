alter table public.odin_scan_snapshots
  drop constraint if exists odin_scan_snapshots_source_check;

alter table public.odin_scan_snapshots
  add constraint odin_scan_snapshots_source_check
  check (source in ('gmail', 'slack', 'calendar', 'health', 'browser', 'weather'));
