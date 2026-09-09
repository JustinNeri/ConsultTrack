-- Files attached to a consultation.
--
-- The booking form has always had a drop zone. It listed what you dropped and
-- then threw it away: the note under it read "interface only for now - files are
-- listed here but not uploaded with the booking". This is the storage behind it.
--
-- Two halves, deliberately:
--   storage.objects  holds the bytes, in a private bucket
--   this table       holds what the app needs to list them without touching
--                    storage: original filename, size, type, who sent it
--
-- The metadata row is the source of truth for "does this consultation have
-- attachments". A listing never has to enumerate a bucket, and a file whose row
-- is gone is invisible to the app whatever is left in storage.

-- ------------------------------------------------------------------ bucket
-- Private. Everything is read through a short-lived signed URL minted by the
-- API for someone who has already proved they can see the consultation.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'consultation-attachments',
  'consultation-attachments',
  false,
  10485760, -- 10 MB; these are chapters and screenshots, not datasets
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'text/plain'
  ]
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ------------------------------------------------------------------- table
create table if not exists public.consultation_attachments (
  id               uuid primary key default gen_random_uuid(),
  consultation_id  uuid not null references public.consultations (id) on delete cascade,
  -- Path within the bucket: '<consultation_id>/<uuid>.<ext>'. Never the user's
  -- own filename -- two groups both sending "Chapter4.docx" must not collide,
  -- and a filename is attacker-controlled input to a path.
  storage_path     text not null unique,
  -- What it was called on their machine, which is what we show and what a
  -- download is named.
  file_name        text not null,
  content_type     text,
  byte_size        integer not null check (byte_size >= 0),
  uploaded_by      uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now()
);

comment on table public.consultation_attachments is
  'Files sent with a consultation. Bytes live in the consultation-attachments bucket; this is the listing.';
comment on column public.consultation_attachments.storage_path is
  'Generated path inside the bucket. Never derived from the uploaded filename.';
comment on column public.consultation_attachments.file_name is
  'The original filename, shown in the UI and used for the download.';

-- Every read is "the attachments on this consultation".
create index if not exists consultation_attachments_consultation_idx
  on public.consultation_attachments (consultation_id, created_at);

-- ------------------------------------------------------------------- RLS
-- As elsewhere: the API connects as the owner, so this is defence in depth. The
-- rule about who may see a consultation lives in loadConsultationFor().
alter table public.consultation_attachments enable row level security;

drop policy if exists consultation_attachments_select on public.consultation_attachments;
create policy consultation_attachments_select on public.consultation_attachments
  for select using (
    exists (
      select 1
        from public.consultations c
        left join public.profiles p on p.id = auth.uid()
       where c.id = consultation_attachments.consultation_id
         and (
           c.adviser_id = auth.uid()
           or c.created_by = auth.uid()
           or (p.group_name is not null and p.group_name = c.group_name)
         )
    )
  );

drop policy if exists consultation_attachments_write on public.consultation_attachments;
create policy consultation_attachments_write on public.consultation_attachments
  for all using (
    exists (
      select 1
        from public.consultations c
        left join public.profiles p on p.id = auth.uid()
       where c.id = consultation_attachments.consultation_id
         and (
           c.adviser_id = auth.uid()
           or c.created_by = auth.uid()
           or (p.group_name is not null and p.group_name = c.group_name)
         )
    )
  );

-- --------------------------------------------------------- storage policies
-- The bucket mirrors the table: you may touch an object only if you may see the
-- consultation whose id is the first path segment.
drop policy if exists consultation_attachments_objects_read on storage.objects;
create policy consultation_attachments_objects_read on storage.objects
  for select using (
    bucket_id = 'consultation-attachments'
    and exists (
      select 1
        from public.consultations c
        left join public.profiles p on p.id = auth.uid()
       where c.id::text = split_part(storage.objects.name, '/', 1)
         and (
           c.adviser_id = auth.uid()
           or c.created_by = auth.uid()
           or (p.group_name is not null and p.group_name = c.group_name)
         )
    )
  );

drop policy if exists consultation_attachments_objects_write on storage.objects;
create policy consultation_attachments_objects_write on storage.objects
  for insert with check (
    bucket_id = 'consultation-attachments'
    and exists (
      select 1
        from public.consultations c
        left join public.profiles p on p.id = auth.uid()
       where c.id::text = split_part(storage.objects.name, '/', 1)
         and (
           c.adviser_id = auth.uid()
           or c.created_by = auth.uid()
           or (p.group_name is not null and p.group_name = c.group_name)
         )
    )
  );

drop policy if exists consultation_attachments_objects_delete on storage.objects;
create policy consultation_attachments_objects_delete on storage.objects
  for delete using (
    bucket_id = 'consultation-attachments'
    and owner = auth.uid()
  );
