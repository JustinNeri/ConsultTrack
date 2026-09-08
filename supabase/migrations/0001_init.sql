-- ConsultTrack - initial schema
-- Tables: profiles, consultations, action_items (+ RLS and auth trigger)

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  email       text unique,
  role        text not null default 'student' check (role in ('student', 'adviser')),
  -- group_name links a student to their thesis group. Not in the original spec,
  -- but without it there is no way to tell which consultations a student may see.
  group_name  text,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------- consultations
create table if not exists public.consultations (
  id            uuid primary key default gen_random_uuid(),
  adviser_id    uuid references public.profiles (id) on delete set null,
  group_name    text not null,
  topic         text not null,
  location      text,
  meeting_date  timestamptz not null,
  status        text not null default 'scheduled'
                check (status in ('scheduled', 'completed', 'cancelled')),
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists consultations_adviser_date_idx
  on public.consultations (adviser_id, meeting_date);
create index if not exists consultations_group_date_idx
  on public.consultations (group_name, meeting_date);

-- ------------------------------------------------------------ action_items
create table if not exists public.action_items (
  id                uuid primary key default gen_random_uuid(),
  consultation_id   uuid not null references public.consultations (id) on delete cascade,
  task_description  text not null,
  assignee_id       uuid references public.profiles (id) on delete set null,
  status            text not null default 'pending' check (status in ('pending', 'resolved')),
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);

create index if not exists action_items_consultation_idx
  on public.action_items (consultation_id);
create index if not exists action_items_assignee_status_idx
  on public.action_items (assignee_id, status);

-- ------------------------------------------- create a profile on auth signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'role', 'student')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------ RLS helpers
-- security definer so policies on `profiles` do not recurse into themselves
create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.current_group_name()
returns text language sql stable security definer set search_path = public as $$
  select group_name from public.profiles where id = auth.uid()
$$;

-- ------------------------------------------------------------------- RLS
alter table public.profiles      enable row level security;
alter table public.consultations enable row level security;
alter table public.action_items  enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.current_role_name() = 'adviser');

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists consultations_select on public.consultations;
create policy consultations_select on public.consultations
  for select using (
    adviser_id = auth.uid()
    or created_by = auth.uid()
    or group_name = public.current_group_name()
  );

drop policy if exists consultations_insert on public.consultations;
create policy consultations_insert on public.consultations
  for insert with check (
    created_by = auth.uid()
    and (adviser_id = auth.uid() or group_name = public.current_group_name())
  );

drop policy if exists consultations_update on public.consultations;
create policy consultations_update on public.consultations
  for update using (adviser_id = auth.uid() or created_by = auth.uid());

drop policy if exists action_items_select on public.action_items;
create policy action_items_select on public.action_items
  for select using (
    assignee_id = auth.uid()
    or exists (
      select 1 from public.consultations c
      where c.id = action_items.consultation_id
        and (c.adviser_id = auth.uid() or c.group_name = public.current_group_name())
    )
  );

drop policy if exists action_items_write on public.action_items;
create policy action_items_write on public.action_items
  for all using (
    assignee_id = auth.uid()
    or exists (
      select 1 from public.consultations c
      where c.id = action_items.consultation_id
        and (c.adviser_id = auth.uid() or c.group_name = public.current_group_name())
    )
  );
