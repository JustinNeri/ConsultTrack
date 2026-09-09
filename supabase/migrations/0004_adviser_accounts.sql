-- Adviser (faculty) accounts.
--
-- Role is decided by the email domain at sign-up: @student.hau.edu.ph creates a
-- student, plain @hau.edu.ph creates an adviser. Advisers carry a faculty ID and
-- an academic position instead of a student ID, course and year level.
--
-- The first two ALTERs reconcile drift: `year_level` and
-- `registration_completed_at` were added straight to the hosted project and were
-- never written down here, so a fresh environment built from these files alone
-- was missing them.
alter table public.profiles
  add column if not exists year_level                text,
  add column if not exists registration_completed_at timestamptz,
  add column if not exists employee_id               text,
  add column if not exists faculty_position          text;

comment on column public.profiles.employee_id is
  'HAU faculty/employee number. Advisers only; students have a student_id.';
comment on column public.profiles.faculty_position is
  'Academic rank, e.g. Professor or Instructor. Advisers only.';

-- Faculty IDs are unique when present, mirroring profiles_student_id_key.
create unique index if not exists profiles_employee_id_key
  on public.profiles (employee_id)
  where employee_id is not null;

-- Advisers are looked up as a directory when a student books a consultation.
create index if not exists profiles_role_idx
  on public.profiles (role)
  where registration_completed_at is not null;

-- Carry the adviser metadata from auth.users into the profile row, alongside the
-- student fields already handled in 0003.
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
    student_id, department, course, year_level,
    employee_id, faculty_position
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
    nullif(meta ->> 'course', ''),
    nullif(meta ->> 'year_level', ''),
    nullif(meta ->> 'employee_id', ''),
    nullif(meta ->> 'faculty_position', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
