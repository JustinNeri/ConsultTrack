-- Consultation requests need the adviser's approval before they are official.
--
-- A student's booking now lands as 'pending' and shows up on the adviser's
-- dashboard as a request. Only when the adviser approves does it become
-- 'scheduled' -- which is the status every "upcoming consultation" query
-- already filters on, so a pending request cannot masquerade as a real session.
-- 'declined' is the adviser saying no, kept (rather than deleted) so the student
-- sees the answer and the reason.
--
-- An adviser booking with one of their own groups still goes straight to
-- 'scheduled': they are the approver, so there is nobody left to ask.

alter table public.consultations
  drop constraint if exists consultations_status_check;

alter table public.consultations
  add constraint consultations_status_check
  check (status in ('pending', 'scheduled', 'completed', 'cancelled', 'declined'));

alter table public.consultations
  add column if not exists responded_at   timestamptz,
  add column if not exists decline_reason text;

comment on column public.consultations.responded_at is
  'When the adviser approved or declined the request. Null while pending.';
comment on column public.consultations.decline_reason is
  'The adviser''s note when declining, shown to the student.';

-- The adviser''s pending-request list is read on every dashboard load.
create index if not exists consultations_adviser_status_idx
  on public.consultations (adviser_id, status, meeting_date);

-- Note: the API talks to Postgres as the owner, so these policies are defence in
-- depth rather than the enforcement point. The rule that only the assigned
-- adviser may approve lives in PATCH /api/consultations/:id/decision.
