-- Who was actually in the room.
--
-- The consultation record this feeds is the paper logbook a group brings to
-- their defense, and "members present" is on every version of that form. Without
-- it the record says a session happened but not who turned up, which is exactly
-- the thing an adviser is being asked to attest to.
--
-- Recorded during the wrap-up, alongside the minutes, because that is the only
-- moment anyone knows the answer.
--
-- There is deliberately no separate "adviser signed this record" table. A
-- completed consultation is already the adviser's attestation -- they wrote the
-- minutes and marked it done -- so the record cites `completed_at` per session
-- and leaves a signature line for the wet signature these forms get anyway.

create table if not exists public.consultation_attendance (
  consultation_id  uuid not null references public.consultations (id) on delete cascade,
  profile_id       uuid not null references public.profiles (id) on delete cascade,
  -- Absence is a fact worth recording, not just a missing row: "we marked Kier
  -- absent" and "we never took attendance" are different claims.
  present          boolean not null default true,
  recorded_at      timestamptz not null default now(),

  primary key (consultation_id, profile_id)
);

comment on table public.consultation_attendance is
  'Who attended one consultation. Recorded by the adviser at wrap-up; printed on the record.';
comment on column public.consultation_attendance.present is
  'False is an explicit absence. No row at all means attendance was never taken.';

-- The record reads attendance one session at a time.
create index if not exists consultation_attendance_profile_idx
  on public.consultation_attendance (profile_id);

-- ------------------------------------------------------------------- RLS
-- As elsewhere: the API connects as the owner, so this is defence in depth. The
-- rule that only the adviser records attendance lives in the wrap-up route.
alter table public.consultation_attendance enable row level security;

drop policy if exists consultation_attendance_select on public.consultation_attendance;
create policy consultation_attendance_select on public.consultation_attendance
  for select using (
    exists (
      select 1 from public.consultations c
       where c.id = consultation_attendance.consultation_id
    )
  );

drop policy if exists consultation_attendance_write on public.consultation_attendance;
create policy consultation_attendance_write on public.consultation_attendance
  for all using (
    exists (
      select 1 from public.consultations c
       where c.id = consultation_attendance.consultation_id
         and c.adviser_id = auth.uid()
    )
  );
