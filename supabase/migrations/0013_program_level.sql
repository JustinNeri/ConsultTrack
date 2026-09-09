-- Program-level ConsultTrack.
--
-- Everything so far modelled one group and one adviser. A capstone program is
-- bigger than that: somebody coordinates it, advisers are assigned rather than
-- chosen, milestones differ between colleges, and a final defense is faced by a
-- panel rather than by one person. This migration is what the app needs to
-- serve a program instead of a pair.

-- ------------------------------------------------------------ coordinator --
-- A flag rather than a third role.
--
-- `role` is derived from the email domain and is checked in dozens of places as
-- `= 'adviser'`. A capstone coordinator is a faculty member who also coordinates,
-- so making it a role would either break every one of those checks or force
-- coordinators to stop advising. The capability is orthogonal to the role, so it
-- is stored that way.
--
-- There is no super-admin to grant it, which is deliberate: the first
-- coordinator is set in SQL by whoever owns the database.
--   update public.profiles set is_coordinator = true where email = '...';
alter table public.profiles
  add column if not exists is_coordinator boolean not null default false;

comment on column public.profiles.is_coordinator is
  'Faculty who also coordinate their department''s capstone program. Grants the cross-group views; orthogonal to role.';

-- How many groups an adviser will take. Null means no limit was set, which is
-- different from a limit of zero.
alter table public.profiles
  add column if not exists adviser_capacity smallint
    check (adviser_capacity is null or adviser_capacity between 0 and 99);

comment on column public.profiles.adviser_capacity is
  'Maximum thesis groups this adviser accepts. Null means unlimited.';

create index if not exists profiles_coordinator_idx
  on public.profiles (department) where is_coordinator;

-- ------------------------------------------------------ adviser assignment --
-- A group's adviser, assigned by the coordinator.
--
-- Until now a student picked whoever they liked from the department directory
-- and the "adviser" of a group was whoever happened to be on its last booking.
-- Where an assignment exists it is the answer, and booking is held to it.
alter table public.thesis_groups
  add column if not exists adviser_id uuid references public.profiles (id) on delete set null;
alter table public.thesis_groups
  add column if not exists adviser_assigned_at timestamptz;
alter table public.thesis_groups
  add column if not exists adviser_assigned_by uuid references public.profiles (id) on delete set null;

comment on column public.thesis_groups.adviser_id is
  'The adviser assigned to this group by a coordinator. Null means the group still chooses per booking.';

create index if not exists thesis_groups_adviser_idx on public.thesis_groups (adviser_id);
create index if not exists thesis_groups_department_idx on public.thesis_groups (department, section);

-- --------------------------------------------------- configurable milestones
-- The capstone sequence, per department.
--
-- The five steps used to be a constant in the React bundle and a CHECK
-- constraint here. They describe one program; the School of Nursing does not
-- have a "System Review". Rows, keyed by department, with an explicit position.
create table if not exists public.program_milestones (
  id          uuid primary key default gen_random_uuid(),
  -- Null is the fallback set, used by any department with none of its own.
  department  text,
  key         text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  label       text not null check (length(btrim(label)) between 2 and 80),
  position    smallint not null check (position between 1 and 40),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.program_milestones is
  'The capstone sequence a department measures its groups against. A null department is the fallback set.';

-- One key per department, and one step per position.
create unique index if not exists program_milestones_key_idx
  on public.program_milestones (coalesce(department, ''), key);
create unique index if not exists program_milestones_position_idx
  on public.program_milestones (coalesce(department, ''), position);

-- The old CHECK hard-coded the five keys, which is exactly what this replaces.
alter table public.group_milestones
  drop constraint if exists group_milestones_milestone_valid;

-- Seed the fallback set with what the app has always shown.
insert into public.program_milestones (department, key, label, position)
values (null, 'title_proposal', 'Title Proposal', 1),
       (null, 'chapters_1_3',   'Chapters 1-3',   2),
       (null, 'data_gathering', 'Data Gathering', 3),
       (null, 'system_review',  'System Review',  4),
       (null, 'final_defense',  'Final Defense',  5)
on conflict do nothing;

-- ----------------------------------------------------- panel consultations --
-- Extra advisers on one consultation.
--
-- `consultations.adviser_id` stays the lead: they own the diary the slot came
-- out of, and they are the one who wraps the session up. A panelist sits beside
-- them, can see the session and its thread, and is named on the record -- which
-- is the document that proves who was on the panel.
create table if not exists public.consultation_panelists (
  consultation_id uuid not null references public.consultations (id) on delete cascade,
  adviser_id      uuid not null references public.profiles (id) on delete cascade,
  role            text not null default 'panelist'
                    check (role in ('panelist', 'chair')),
  added_at        timestamptz not null default now(),
  added_by        uuid references public.profiles (id) on delete set null,

  primary key (consultation_id, adviser_id)
);

comment on table public.consultation_panelists is
  'Advisers on a consultation besides the lead. A final defense is faced by a panel; the record has to name it.';

create index if not exists consultation_panelists_adviser_idx
  on public.consultation_panelists (adviser_id);

-- --------------------------------------------------------- record submission
-- The moment a group hands their record in.
--
-- The record is generated from live rows, so it changes whenever anything
-- behind it changes. A submission freezes what was handed in, which is the only
-- thing that makes "this is what we submitted" a checkable claim.
--
-- The snapshot is the record's own JSON rather than a PDF: rendering a PDF
-- server-side needs a headless browser, which does not fit a serverless deploy,
-- and a PDF is not more trustworthy than the rows it was made from. Printing
-- still works exactly as before.
create table if not exists public.record_submissions (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.thesis_groups (id) on delete cascade,
  submitted_by  uuid references public.profiles (id) on delete set null,
  submitted_at  timestamptz not null default now(),
  session_count integer not null default 0,
  note          text,
  snapshot      jsonb not null
);

comment on table public.record_submissions is
  'A frozen copy of a group''s consultation record at the moment they submitted it.';

create index if not exists record_submissions_group_idx
  on public.record_submissions (group_id, submitted_at desc);

-- ------------------------------------------------------------ feedback -----
-- What the group thought of a session.
--
-- One row per person per consultation, and only on sessions that actually
-- happened. Advisers see it aggregated rather than attributed, so that a
-- student answering honestly is not answering to the person they are rating.
create table if not exists public.consultation_feedback (
  consultation_id uuid not null references public.consultations (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  rating          smallint not null check (rating between 1 and 5),
  comment         text check (comment is null or length(comment) <= 1000),
  created_at      timestamptz not null default now(),

  primary key (consultation_id, profile_id)
);

comment on table public.consultation_feedback is
  'A group member''s rating of one consultation. Shown to advisers in aggregate, never attributed.';

create index if not exists consultation_feedback_consultation_idx
  on public.consultation_feedback (consultation_id);

-- ------------------------------------------------------------------- RLS ---
-- As elsewhere: the API connects as the owner, so these are defence in depth.

alter table public.program_milestones enable row level security;
drop policy if exists program_milestones_select on public.program_milestones;
create policy program_milestones_select on public.program_milestones
  for select using (true);

alter table public.consultation_panelists enable row level security;
drop policy if exists consultation_panelists_select on public.consultation_panelists;
create policy consultation_panelists_select on public.consultation_panelists
  for select using (
    adviser_id = auth.uid()
    or exists (
      select 1 from public.consultations c
       where c.id = consultation_panelists.consultation_id
         and (
           c.adviser_id = auth.uid()
           or exists (
             select 1 from public.thesis_group_members m
              where m.group_id = c.group_id and m.profile_id = auth.uid()
           )
         )
    )
  );

alter table public.record_submissions enable row level security;
drop policy if exists record_submissions_select on public.record_submissions;
create policy record_submissions_select on public.record_submissions
  for select using (
    exists (
      select 1 from public.thesis_group_members m
       where m.group_id = record_submissions.group_id and m.profile_id = auth.uid()
    )
    or exists (
      select 1 from public.thesis_groups g
       where g.id = record_submissions.group_id and g.adviser_id = auth.uid()
    )
  );

alter table public.consultation_feedback enable row level security;
-- Only your own row. An adviser reads this aggregated, through the API.
drop policy if exists consultation_feedback_own on public.consultation_feedback;
create policy consultation_feedback_own on public.consultation_feedback
  for all using (profile_id = auth.uid());
