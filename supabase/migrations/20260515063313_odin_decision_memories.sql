-- Allow ODIN to store explicit Peter-confirmed decision memories.

set search_path = public;

alter table public.odin_memories
  drop constraint if exists odin_memories_kind_check;

alter table public.odin_memories
  add constraint odin_memories_kind_check
  check (kind in (
    'preference',
    'business',
    'person',
    'tone',
    'priority',
    'routine',
    'source',
    'decision',
    'other'
  ));

alter table public.odin_memories
  drop constraint if exists odin_memories_source_check;

alter table public.odin_memories
  add constraint odin_memories_source_check
  check (source in ('manual', 'odin', 'system', 'user_confirmed'));
