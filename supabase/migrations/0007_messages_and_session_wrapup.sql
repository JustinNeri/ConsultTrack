-- Consultation threads, and the wrap-up that closes a session.
--
-- Two gaps this fills, and they are the same gap seen from two ends.
--
-- 1. A decline was a dead end. `decline_reason` is one sentence with no reply
--    channel, so "I have a class then, try Thursday" ended the conversation
--    instead of continuing it. A thread hangs off the consultation itself.
--
-- 2. A consultation could never finish. 'completed' and 'cancelled' were in the
--    status CHECK from 0005 but nothing in the API could reach them: a session
--    happened, dropped out of the `meeting_date >= now()` filter, and was gone.
--    Nothing recorded that it took place, and `action_items` had no writer at
--    all -- the whole Action items screen could only ever be empty.
--
-- Threads are scoped to a consultation rather than to a student/adviser pair on
-- purpose: there is no standing group-to-adviser link in this schema (an adviser
-- is chosen per booking), so a pair has no natural scope. A consultation already
-- carries both sides and an access rule, and both come for free.

-- ------------------------------------------------------- consultation_messages
create table if not exists public.consultation_messages (
  id               uuid primary key default gen_random_uuid(),
  consultation_id  uuid not null references public.consultations (id) on delete cascade,
  -- Cascade: a deleted profile takes its messages with it. A thread with holes
  -- in it is worse than a shorter thread, and there is no "deleted user" to
  -- attribute an orphan to.
  sender_id        uuid not null references public.profiles (id) on delete cascade,
  body             text not null,
  created_at       timestamptz not null default now(),

  constraint consultation_messages_body_check
    check (length(btrim(body)) between 1 and 2000)
);

comment on table public.consultation_messages is
  'Chat thread attached to one consultation. Visible to its adviser and its group.';

-- Every read of a thread is "this consultation, oldest first".
create index if not exists consultation_messages_thread_idx
  on public.consultation_messages (consultation_id, created_at);

-- ---------------------------------------------------------- consultation_reads
-- One high-water mark per person per thread, rather than a read flag per
-- message per person: the unread badge only ever needs "since when".
create table if not exists public.consultation_reads (
  consultation_id  uuid not null references public.consultations (id) on delete cascade,
  profile_id       uuid not null references public.profiles (id) on delete cascade,
  last_read_at     timestamptz not null default now(),

  primary key (consultation_id, profile_id)
);

comment on table public.consultation_reads is
  'How far each person has read in a consultation thread. Drives the unread count.';

-- The badge counts unread across every thread the caller can see.
create index if not exists consultation_reads_profile_idx
  on public.consultation_reads (profile_id);

-- ------------------------------------------------------------- session wrap-up
alter table public.consultations
  add column if not exists minutes      text,
  add column if not exists completed_at timestamptz;

comment on column public.consultations.minutes is
  'What was agreed in the session. Written by the adviser when completing it.';
comment on column public.consultations.completed_at is
  'When the adviser marked the session done. Null until then.';

-- Past sessions are listed newest first, per adviser or per group.
create index if not exists consultations_completed_idx
  on public.consultations (adviser_id, completed_at desc)
  where status = 'completed';

-- ---------------------------------------------------------------- action items
-- An action item raised in a session is usually due before the next one, which
-- is not the same date as the session it came out of. The dashboard was showing
-- the consultation date in the slot where a deadline belongs.
alter table public.action_items
  add column if not exists due_date date;

comment on column public.action_items.due_date is
  'Optional deadline set by the adviser. Distinct from the session it came from.';

-- ------------------------------------------------------------------- RLS
-- As in 0005 and 0006: the API connects as the owner, so these are defence in
-- depth. The access rule that matters lives in the routes, which resolve every
-- thread through the same consultation-visibility predicate.
alter table public.consultation_messages enable row level security;
alter table public.consultation_reads    enable row level security;

-- Reachability of the parent consultation is the whole access rule: RLS on
-- public.consultations already limits that to its adviser, its group, and
-- whoever created it.
drop policy if exists consultation_messages_select on public.consultation_messages;
create policy consultation_messages_select on public.consultation_messages
  for select using (
    exists (
      select 1 from public.consultations c
       where c.id = consultation_messages.consultation_id
    )
  );

drop policy if exists consultation_messages_insert on public.consultation_messages;
create policy consultation_messages_insert on public.consultation_messages
  for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.consultations c
       where c.id = consultation_messages.consultation_id
    )
  );

drop policy if exists consultation_reads_own on public.consultation_reads;
create policy consultation_reads_own on public.consultation_reads
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());
