-- Registration fields for Holy Angel University students.
alter table public.profiles
  add column if not exists last_name        text,
  add column if not exists first_name       text,
  add column if not exists middle_initial   text,
  add column if not exists student_id       text,
  add column if not exists department       text,
  add column if not exists course           text,
  add column if not exists email_verified_at timestamptz;

-- Student IDs are unique when present; advisers have none.
create unique index if not exists profiles_student_id_key
  on public.profiles (student_id)
  where student_id is not null;

-- Carry the registration metadata from auth.users into the profile row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (
    id, email, role, full_name,
    last_name, first_name, middle_initial,
    student_id, department, course
  )
  values (
    new.id,
    new.email,
    coalesce(meta ->> 'role', 'student'),
    coalesce(nullif(meta ->> 'full_name', ''), split_part(new.email, '@', 1)),
    nullif(meta ->> 'last_name', ''),
    nullif(meta ->> 'first_name', ''),
    nullif(meta ->> 'middle_initial', ''),
    nullif(meta ->> 'student_id', ''),
    nullif(meta ->> 'department', ''),
    nullif(meta ->> 'course', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
