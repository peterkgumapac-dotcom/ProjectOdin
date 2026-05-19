-- ODIN Health profile.
-- Stores Peter's editable coaching goals, selected plan, and summarized file context.
-- Raw uploaded health file bodies are intentionally not stored.

set search_path = public;

create table if not exists public.health_profiles (
  user_id                 uuid primary key references public.users(id) on delete cascade,
  focus                   text not null default 'fat_loss'
                          check (focus in ('fat_loss', 'strength', 'recovery', 'busy')),
  target_weight_kg        numeric,
  daily_steps             integer not null default 8000
                          check (daily_steps > 0),
  sleep_hours             numeric not null default 7.5
                          check (sleep_hours > 0),
  strength_days           integer not null default 3
                          check (strength_days >= 0 and strength_days <= 7),
  protein_grams           integer
                          check (protein_grams is null or protein_grams > 0),
  diet_style              text not null default 'high_protein'
                          check (diet_style in ('balanced', 'high_protein', 'lower_carb', 'plant_forward')),
  notes                   text not null default '',
  context_summaries       jsonb not null default '[]'::jsonb,
  active_plan             jsonb not null default '{}'::jsonb,
  active_plan_selected_at timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.health_profiles enable row level security;

drop trigger if exists health_profiles_updated_at on public.health_profiles;
create trigger health_profiles_updated_at
  before update on public.health_profiles
  for each row execute function public.set_updated_at();

create index if not exists health_profiles_updated_idx
  on public.health_profiles(updated_at desc);

drop policy if exists "health_profiles: select own" on public.health_profiles;
create policy "health_profiles: select own" on public.health_profiles
  for select using (auth.uid() = user_id);

drop policy if exists "health_profiles: insert own" on public.health_profiles;
create policy "health_profiles: insert own" on public.health_profiles
  for insert with check (auth.uid() = user_id);

drop policy if exists "health_profiles: update own" on public.health_profiles;
create policy "health_profiles: update own" on public.health_profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "health_profiles: delete own" on public.health_profiles;
create policy "health_profiles: delete own" on public.health_profiles
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.health_profiles to authenticated;
