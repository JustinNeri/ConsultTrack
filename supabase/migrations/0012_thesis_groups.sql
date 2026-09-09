-- Sections, and thesis groups that actually exist.
--
-- Until now a "group" was a string. A student typed "Group 7 - Campus Nav" when
-- booking, and every query that decided who may see a consultation compared that
-- string to `profiles.group_name`. Two consequences, both bad:
--
--   * a typo silently split a group in half, and neither half could see the
--     other's sessions;
--   * nothing anywhere recorded who was in a group, so a consultation booked by
--     one member reached the others only by string coincidence.
--
-- This makes the group a row, with members. A consultation now carries
-- `group_id`, so a booking by any member reaches all of them because they are in
-- the same group, not because they typed the same words.
--
-- `section` is the class a student belongs to -- "CS-401". Group names are only
-- unique within one, since every section has a "Group 1".

-- --------------------------------------------------------------- section --
-- Nullable on purpose. 43 accounts already exist without one; a NOT NULL here
-- would lock every one of them out. New registrations are required to give a
-- section by the API, and the app prompts anyone older to fill theirs in.
alter table public.profiles
  add column if not exists section text;

comment on column public.profiles.section is
  'Class section, e.g. CS-401. Required for new student registrations; older accounts may be null until they fill it in.';

create index if not exists profiles_section_idx on public.profiles (section);

-- ---------------------------------------------------------------- groups --
create table if not exists public.thesis_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 120),
  -- Denormalised from the creator's profile. A group belongs to one section,
  -- and that is what makes its name unique.
  section     text not null,
  department  text,
  -- What a member types to join. Short enough to read aloud in a corridor,
  -- random enough not to be guessed at.
  join_code   text not null unique check (join_code ~ '^[A-Z0-9]{6}$'),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.thesis_groups is
  'A thesis group. Members join with join_code; consultations reference it by id.';
comment on column public.thesis_groups.join_code is
  'Six uppercase alphanumerics. Shared by the leader so members can join.';

-- Every section has a "Group 1", so the name is unique per section, not globally.
create unique index if not exists thesis_groups_name_per_section
  on public.thesis_groups (lower(btrim(name)), section);

-- --------------------------------------------------------------- members --
create table if not exists public.thesis_group_members (
  group_id    uuid not null references public.thesis_groups (id) on delete cascade,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  -- The leader created the group and is the only one who can rename or disband
  -- it. Everything else a member can do too.
  role        text not null default 'member' check (role in ('leader', 'member')),
  joined_at   timestamptz not null default now(),

  primary key (group_id, profile_id)
);

comment on table public.thesis_group_members is
  'Who is in a thesis group. A student belongs to at most one.';

-- One group per student. Without this a student in two groups would see two
-- capstone trackers and neither would be right.
create unique index if not exists thesis_group_members_one_per_student
  on public.thesis_group_members (profile_id);

create index if not exists thesis_group_members_group_idx
  on public.thesis_group_members (group_id);

-- -------------------------------------------------- consultations.group_id
-- Nullable, because the rows that predate this have no group to point at. Every
-- query that reads it falls back to the old group_name comparison when it is
-- null, so old consultations keep working exactly as they did.
alter table public.consultations
  add column if not exists group_id uuid references public.thesis_groups (id) on delete set null;

comment on column public.consultations.group_id is
  'The thesis group this session belongs to. Null on rows created before groups existed; those fall back to matching group_name.';

create index if not exists consultations_group_id_idx on public.consultations (group_id);

-- ------------------------------------------------------------ milestones --
-- group_milestones was keyed by group_name, which is no longer unique on its
-- own: two sections both with a "Group 1" would have shared a progress tracker.
-- Re-key it on the group id. Safe to recreate outright -- it holds no rows.
drop table if exists public.group_milestones;

create table public.group_milestones (
  group_id         uuid not null references public.thesis_groups (id) on delete cascade,
  milestone        text not null,
  completed_at     timestamptz not null default now(),
  completed_by     uuid references public.profiles (id) on delete set null,
  consultation_id  uuid references public.consultations (id) on delete set null,

  primary key (group_id, milestone),

  constraint group_milestones_milestone_valid check (
    milestone in (
      'title_proposal',
      'chapters_1_3',
      'data_gathering',
      'system_review',
      'final_defense'
    )
  )
);

comment on table public.group_milestones is
  'Capstone milestones a thesis group has reached. Marked by their adviser; drives the progress tracker.';

create index if not exists group_milestones_completed_by_idx
  on public.group_milestones (completed_by);

-- ------------------------------------------------------------------- RLS
-- As elsewhere: the API connects as the owner, so this is defence in depth.

alter table public.thesis_groups enable row level security;

-- A group is readable by its members, and by any adviser who has a consultation
-- with it. Joining needs the code, which the join route checks before it reads,
-- so there is no policy that exposes the directory.
drop policy if exists thesis_groups_select on public.thesis_groups;
create policy thesis_groups_select on public.thesis_groups
  for select using (
    exists (
      select 1 from public.thesis_group_members m
       where m.group_id = thesis_groups.id and m.profile_id = auth.uid()
    )
    or exists (
      select 1 from public.consultations c
       where c.group_id = thesis_groups.id and c.adviser_id = auth.uid()
    )
  );

-- Any student may create a group; they become its leader in the same
-- transaction. Only the leader may change it afterwards.
drop policy if exists thesis_groups_insert on public.thesis_groups;
create policy thesis_groups_insert on public.thesis_groups
  for insert with check (created_by = auth.uid());

drop policy if exists thesis_groups_update on public.thesis_groups;
create policy thesis_groups_update on public.thesis_groups
  for update using (
    exists (
      select 1 from public.thesis_group_members m
       where m.group_id = thesis_groups.id
         and m.profile_id = auth.uid()
         and m.role = 'leader'
    )
  );

alter table public.thesis_group_members enable row level security;

drop policy if exists thesis_group_members_select on public.thesis_group_members;
create policy thesis_group_members_select on public.thesis_group_members
  for select using (
    profile_id = auth.uid()
    or exists (
      select 1 from public.thesis_group_members mine
       where mine.group_id = thesis_group_members.group_id
         and mine.profile_id = auth.uid()
    )
    or exists (
      select 1 from public.consultations c
       where c.group_id = thesis_group_members.group_id
         and c.adviser_id = auth.uid()
    )
  );

-- You may add or remove only yourself. The leader removing somebody else goes
-- through the API, which connects as the owner.
drop policy if exists thesis_group_members_write on public.thesis_group_members;
create policy thesis_group_members_write on public.thesis_group_members
  for all using (profile_id = auth.uid());

alter table public.group_milestones enable row level security;

drop policy if exists group_milestones_select on public.group_milestones;
create policy group_milestones_select on public.group_milestones
  for select using (
    exists (
      select 1 from public.thesis_group_members m
       where m.group_id = group_milestones.group_id and m.profile_id = auth.uid()
    )
    or exists (
      select 1 from public.consultations c
       where c.group_id = group_milestones.group_id and c.adviser_id = auth.uid()
    )
  );

drop policy if exists group_milestones_write on public.group_milestones;
create policy group_milestones_write on public.group_milestones
  for all using (
    exists (
      select 1 from public.consultations c
       where c.group_id = group_milestones.group_id and c.adviser_id = auth.uid()
    )
  );
