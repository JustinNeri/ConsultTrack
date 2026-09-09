-- Counter-proposals, rescheduling, and cancellation.
--
-- The gap: a student asks for 9-11am, the adviser is teaching then and wants
-- 12pm. Until now the adviser's only options were approve or decline, so the
-- answer was a sentence in `decline_reason` ("try Thursday") and the group had
-- to start the booking over and hope they guessed right the second time.
--
-- Why the student still has to agree. They asked for 9am because that is when
-- they are free; 12pm is very likely a class. Booking it for them does not
-- produce a meeting, it produces a no-show -- which wastes the adviser's slot
-- *and* lands in the consultation record as a session that never happened.
--
-- Why it is not a negotiation either. The adviser's time is the scarce
-- resource, so this is one counter-offer, then accept or start over. There is
-- no ping-pong: declining a proposal ends the request.
--
-- Whose turn it is, is derivable rather than stored:
--   pending,   proposed_date null      -> the adviser decides
--   pending,   proposed_date set       -> the student answers the counter-offer
--   scheduled, proposed_date set       -> whoever is not proposed_by answers
--
-- A proposal expires on its own: it is live only while `proposed_date > now()`.
-- Nothing has to sweep the table, and a slot stops being held the moment the
-- proposed time passes.

alter table public.consultations
  -- The alternative time being offered. Distinct from meeting_date, which still
  -- holds the *agreed* time until the other side accepts -- so a reschedule
  -- proposal cannot quietly move a session nobody agreed to move.
  add column if not exists proposed_date timestamptz,
  add column if not exists proposed_by   uuid references public.profiles (id) on delete set null,
  add column if not exists proposed_at   timestamptz,
  add column if not exists proposed_note text,
  -- 'cancelled' has been in the status CHECK since 0005 and unreachable ever
  -- since. These are what finally make it mean something.
  add column if not exists cancelled_at   timestamptz,
  add column if not exists cancelled_by   uuid references public.profiles (id) on delete set null,
  add column if not exists cancel_reason  text;

comment on column public.consultations.proposed_date is
  'An alternative time offered to the other side. Live only while it is in the future.';
comment on column public.consultations.proposed_by is
  'Who offered it. The other party is the one who accepts or declines.';
comment on column public.consultations.proposed_note is
  'Why the change is being asked for, e.g. "I have a class at 9".';
comment on column public.consultations.cancel_reason is
  'Why the session was called off, shown to the other side.';

-- A live proposal holds its slot, so the slot query has to find rows by
-- proposed_date as readily as by meeting_date.
create index if not exists consultations_proposed_idx
  on public.consultations (adviser_id, proposed_date)
  where proposed_date is not null and status in ('pending', 'scheduled');

-- Both sides poll "is anything waiting on me?" on every dashboard load.
create index if not exists consultations_turn_idx
  on public.consultations (status, proposed_date)
  where status in ('pending', 'scheduled');
