-- Store automation-generated business escalation summaries for ODIN morning briefs.

set search_path = public;

alter table public.odin_memories
  add column if not exists context_json jsonb not null default '{}'::jsonb;

alter table public.odin_memories
  drop constraint if exists odin_memories_source_check;

alter table public.odin_memories
  add constraint odin_memories_source_check
  check (source in (
    'manual',
    'odin',
    'system',
    'user_confirmed',
    'dinbnb_automation',
    'stayminty_automation'
  ));

create index if not exists odin_memories_source_created_idx
  on public.odin_memories(source, created_at desc);
