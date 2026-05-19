-- ODIN Phase 1 memory tables.
-- Semantic memory stores durable facts; episodic memory stores recent turns.

set search_path = public;

create table if not exists public.semantic_memory (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  fact        text not null,
  category    text not null
              check (category in ('health', 'work', 'travel', 'people', 'preferences')),
  confidence  numeric(3,2) not null default 0.50
              check (confidence >= 0 and confidence <= 1),
  source      text not null default 'inferred',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.semantic_memory enable row level security;

drop trigger if exists semantic_memory_updated_at on public.semantic_memory;
create trigger semantic_memory_updated_at
  before update on public.semantic_memory
  for each row execute function public.set_updated_at();

create index if not exists idx_semantic_user_conf
  on public.semantic_memory(user_id, confidence desc, updated_at desc);

create index if not exists idx_semantic_user_category
  on public.semantic_memory(user_id, category, confidence desc);

drop policy if exists "semantic_memory: select own" on public.semantic_memory;
create policy "semantic_memory: select own" on public.semantic_memory
  for select using (auth.uid() = user_id);

drop policy if exists "semantic_memory: insert own" on public.semantic_memory;
create policy "semantic_memory: insert own" on public.semantic_memory
  for insert with check (auth.uid() = user_id);

drop policy if exists "semantic_memory: update own" on public.semantic_memory;
create policy "semantic_memory: update own" on public.semantic_memory
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "semantic_memory: delete own" on public.semantic_memory;
create policy "semantic_memory: delete own" on public.semantic_memory
  for delete using (auth.uid() = user_id);

create table if not exists public.episodic_memory (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  conversation_id  text,
  user_input       text,
  odin_response    text,
  observation      text,
  user_reaction    text not null default 'neutral'
                   check (user_reaction in ('positive', 'negative', 'neutral', 'overridden')),
  context_json     jsonb not null default '{}'::jsonb,
  compressed       boolean not null default false,
  timestamp        timestamptz not null default now()
);

alter table public.episodic_memory enable row level security;

create index if not exists idx_episodic_user_time
  on public.episodic_memory(user_id, timestamp desc);

create index if not exists idx_episodic_uncompressed
  on public.episodic_memory(user_id, compressed, timestamp desc)
  where compressed = false;

drop policy if exists "episodic_memory: select own" on public.episodic_memory;
create policy "episodic_memory: select own" on public.episodic_memory
  for select using (auth.uid() = user_id);

drop policy if exists "episodic_memory: insert own" on public.episodic_memory;
create policy "episodic_memory: insert own" on public.episodic_memory
  for insert with check (auth.uid() = user_id);

drop policy if exists "episodic_memory: update own" on public.episodic_memory;
create policy "episodic_memory: update own" on public.episodic_memory
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "episodic_memory: delete own" on public.episodic_memory;
create policy "episodic_memory: delete own" on public.episodic_memory
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.semantic_memory to authenticated;
grant select, insert, update, delete on public.episodic_memory to authenticated;

insert into public.semantic_memory (user_id, fact, category, confidence, source)
select
  u.id,
  'Peter crashes after presentations when he sleeps less than 4 hours before flying to Tokyo',
  'health',
  0.90,
  'seeded_for_testing'
from public.users u
where u.email in (
  'peterkgumapac@gmail.com',
  'peter@stayminty.com',
  'peter@afterstay.org'
)
and not exists (
  select 1
  from public.semantic_memory sm
  where sm.user_id = u.id
    and sm.fact = 'Peter crashes after presentations when he sleeps less than 4 hours before flying to Tokyo'
)
order by case u.email
  when 'peterkgumapac@gmail.com' then 1
  when 'peter@stayminty.com' then 2
  when 'peter@afterstay.org' then 3
  else 4
end
limit 1;
