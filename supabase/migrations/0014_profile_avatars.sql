-- Profile pictures.
--
-- Until now an avatar was always initials on crimson, derived from the name.
-- That is still the fallback, and still what most accounts will show: this adds
-- the option of a photograph, not a requirement to have one.
--
-- Two decisions worth stating, because both differ from consultation-attachments
-- one migration earlier:
--
--   The bucket is PUBLIC. Attachments are private and read through a
--   short-lived signed URL, which is right for a chapter draft but wrong for an
--   avatar: an avatar is rendered dozens of times per page, in adviser lists and
--   account menus and group rosters, and minting and refreshing a signed URL per
--   face per render is a great deal of machinery to hide a picture the person
--   chose to show. The object name still carries a random uuid, so nothing is
--   enumerable by guessing a user id.
--
--   The profile stores the finished URL, not the storage path. Every route that
--   returns a profile selects PROFILE_COLUMNS, so a URL column reaches every one
--   of them for free, where a path column would need each of them to learn how
--   to turn a path into something an <img> can use. The cost is that the value
--   embeds the project's storage origin: if the Supabase URL ever changes, one
--   UPDATE over this column fixes it.

-- ------------------------------------------------------------------ bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-avatars',
  'profile-avatars',
  true,
  2097152, -- 2 MB; a face, not a poster
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ------------------------------------------------------------------ column
alter table public.profiles
  add column if not exists avatar_url text;

comment on column public.profiles.avatar_url is
  'Public URL of the profile picture in the profile-avatars bucket. Null means fall back to initials.';

-- --------------------------------------------------------- storage policies
-- Reads need no policy: the bucket is public, so the object endpoint serves it.
-- Writes are the part that matters, and the rule is the same for all three --
-- the first path segment is the owner's id, so you can only ever write inside
-- your own folder.
drop policy if exists profile_avatars_insert on storage.objects;
create policy profile_avatars_insert on storage.objects
  for insert with check (
    bucket_id = 'profile-avatars'
    and split_part(storage.objects.name, '/', 1) = auth.uid()::text
  );

drop policy if exists profile_avatars_update on storage.objects;
create policy profile_avatars_update on storage.objects
  for update using (
    bucket_id = 'profile-avatars'
    and split_part(storage.objects.name, '/', 1) = auth.uid()::text
  );

drop policy if exists profile_avatars_delete on storage.objects;
create policy profile_avatars_delete on storage.objects
  for delete using (
    bucket_id = 'profile-avatars'
    and split_part(storage.objects.name, '/', 1) = auth.uid()::text
  );
