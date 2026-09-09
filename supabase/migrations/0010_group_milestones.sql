-- Capstone milestones, per thesis group.
--
-- The dashboard has always shown a five-step capstone tracker, but the count of
-- finished steps was a constant in the React bundle: every group saw "60% -
-- System Review" whether they had held ten sessions or none. This is the table
-- that makes that panel tell the truth.
--
-- Keyed by `group_name` rather than by student, because a milestone belongs to
-- the thesis group, not to whichever member happens to be logged in. That is the
-- same string `consultations.group_name` and `profiles.group_name` already carry,
-- and it is how the rest of the app decides who may see a group's work.
--
-- Only an adviser writes here. A milestone is an evaluation -- "this group has
-- finished data gathering" is the adviser's judgement, not the group's claim --
-- and the API enforces that the writer actually advises the group. Students read
-- their own progress and nothing else.

create table if not exists public.group_milestones (
  group_name       text not null,
  -- Stable keys, not display labels: the client owns the wording, and renaming
  -- "Chapters 1-3" in the UI must not orphan a group's history.
  milestone        text not null,
  completed_at     timestamptz not null default now(),
  completed_by     uuid references public.profiles (id) on delete set null,
  -- Which session signed it off, when it was signed off at a wrap-up. Null when
  -- an adviser ticks it from the group's milestone panel instead.
  consultation_id  uuid references public.consultations (id) on delete set null,

  primary key (group_name, milestone),

  -- The capstone sequence is fixed by the program, so it is a constraint rather
  -- than a lookup table. Adding a sixth step is a migration, which is correct:
  -- it changes what every group is measured against.
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
comment on column public.group_milestones.milestone is
  'Stable key, not a label. The client maps these to display names.';
comment on column public.group_milestones.consultation_id is
  'The session that signed this milestone off, when it was marked during a wrap-up.';

-- The adviser's own view ("which groups have I signed off, and when") reads by
-- who marked it rather than by group.
create index if not exists group_milestones_completed_by_idx
  on public.group_milestones (completed_by);

-- ------------------------------------------------------------------- RLS
-- As elsewhere: the API connects as the owner, so this is defence in depth. The
-- rule that only a group's own adviser may write lives in the route.
alter table public.group_milestones enable row level security;

-- A group member sees their group's milestones; an adviser sees those of any
-- group they hold a consultation with.
drop policy if exists group_milestones_select on public.group_milestones;
create policy group_milestones_select on public.group_milestones
  for select using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.group_name = group_milestones.group_name
    )
    or exists (
      select 1 from public.consultations c
       where c.group_name = group_milestones.group_name
         and c.adviser_id = auth.uid()
    )
  );

-- Writing is the adviser's alone, and only for a group they actually advise.
drop policy if exists group_milestones_write on public.group_milestones;
create policy group_milestones_write on public.group_milestones
  for all using (
    exists (
      select 1 from public.consultations c
       where c.group_name = group_milestones.group_name
         and c.adviser_id = auth.uid()
    )
  );
