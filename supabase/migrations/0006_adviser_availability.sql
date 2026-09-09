-- Adviser availability (consultation hours) and slot-based booking.
--
-- Before this, a student picked any date and time they liked and the adviser
-- either approved it or declined and suggested another -- a round trip per
-- booking. An adviser now publishes the weekly blocks they are free, and the
-- student books a slot carved out of one, so the request already lands on a
-- time the adviser can take.
--
-- A block is weekly and recurring: "Wednesdays 13:00-16:00, 30-minute slots,
-- Faculty Room 204". `weekday` follows Postgres `extract(dow)` -- 0 is Sunday --
-- so the slot query can compare the two without translating.
--
-- Times are stored as local wall-clock `time` values, not timestamps: an
-- adviser means 1 PM campus time every week, not a fixed UTC instant. The API
-- combines a block with a calendar date in CAMPUS_TIMEZONE (Asia/Manila) to get
-- the real timestamptz for a slot.

create table if not exists public.adviser_availability (
  id            uuid primary key default gen_random_uuid(),
  adviser_id    uuid not null references public.profiles (id) on delete cascade,
  weekday       smallint not null check (weekday between 0 and 6),
  start_time    time not null,
  end_time      time not null,
  -- How long one consultation runs. The block is diced into slots this long.
  slot_minutes  smallint not null default 30 check (slot_minutes between 15 and 180),
  location      text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),

  constraint adviser_availability_range_check check (end_time > start_time),
  -- A block shorter than one slot would produce no bookable time at all.
  constraint adviser_availability_fits_check
    check (extract(epoch from (end_time - start_time)) >= slot_minutes * 60),
  -- Re-adding the same block is a no-op rather than a duplicate row.
  constraint adviser_availability_unique_block
    unique (adviser_id, weekday, start_time, end_time)
);

comment on table public.adviser_availability is
  'Recurring weekly consultation hours an adviser publishes. Students book slots out of these.';
comment on column public.adviser_availability.weekday is
  'Day of week, 0 = Sunday, matching Postgres extract(dow).';
comment on column public.adviser_availability.slot_minutes is
  'Length of one consultation. The block is divided into slots of this size.';

-- The slot query filters on exactly this, on every booking screen.
create index if not exists adviser_availability_adviser_weekday_idx
  on public.adviser_availability (adviser_id, weekday)
  where is_active;

-- A booked slot has to be found fast when building the picker: every pending or
-- scheduled session for one adviser in a day window.
create index if not exists consultations_adviser_date_status_idx
  on public.consultations (adviser_id, meeting_date)
  where status in ('pending', 'scheduled');

-- ------------------------------------------------------------------- RLS
-- As in 0005: the API connects as the owner, so these are defence in depth.
-- The rule that only an adviser edits their own hours lives in the routes.
alter table public.adviser_availability enable row level security;

-- Published hours are a directory: a student has to read their adviser's blocks
-- to see any slots at all.
drop policy if exists adviser_availability_select on public.adviser_availability;
create policy adviser_availability_select on public.adviser_availability
  for select using (auth.uid() is not null);

drop policy if exists adviser_availability_write on public.adviser_availability;
create policy adviser_availability_write on public.adviser_availability
  for all using (adviser_id = auth.uid()) with check (adviser_id = auth.uid());
