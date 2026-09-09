-- Mock adviser accounts -- 5 per department, 40 in total.
--
-- DEMO DATA. These are invented people with invented @hau.edu.ph addresses;
-- none of the mailboxes exist, so the OTP sign-up flow will never work for
-- them. They are seeded straight into auth.users with a bcrypt password so the
-- password sign-in at POST /api/auth/login works, and they show up in the
-- adviser directory (GET /api/advisers) for students to book with.
--
-- Every account shares the same password, defined once below. Change it there
-- and re-run to rotate them all.
--
-- Kept out of supabase/migrations on purpose: this is seed data, not schema.
-- Run it by hand against the dev project, and remove the accounts before the
-- real deployment with:
--
--   delete from auth.users u
--    using public.profiles p
--    where p.id = u.id and p.employee_id like 'FAC-10%';

begin;

create temporary table mock_advisers (
  email            text primary key,
  last_name        text not null,
  first_name       text not null,
  middle_initial   text,
  department       text not null,
  faculty_position text not null,
  employee_id      text not null
) on commit drop;

insert into mock_advisers values
  -- School of Computing
  ('mreyes@hau.edu.ph',        'Reyes',        'Marco',     'A', 'School of Computing', 'Professor',           'FAC-1001'),
  ('lsantos@hau.edu.ph',       'Santos',       'Liza',      'B', 'School of Computing', 'Associate Professor', 'FAC-1002'),
  ('kbautista@hau.edu.ph',     'Bautista',     'Karl',      'D', 'School of Computing', 'Assistant Professor', 'FAC-1003'),
  ('gocampo@hau.edu.ph',       'Ocampo',       'Grace',     'M', 'School of Computing', 'Senior Lecturer',     'FAC-1004'),
  ('pvillanueva@hau.edu.ph',   'Villanueva',   'Paolo',     'R', 'School of Computing', 'Instructor',          'FAC-1005'),

  -- School of Business and Accountancy
  ('amendoza@hau.edu.ph',      'Mendoza',      'Anna',      'L', 'School of Business and Accountancy', 'Professor',           'FAC-1006'),
  ('rcruz@hau.edu.ph',         'Cruz',         'Ramon',     'T', 'School of Business and Accountancy', 'Associate Professor', 'FAC-1007'),
  ('blim@hau.edu.ph',          'Lim',          'Beatriz',   'S', 'School of Business and Accountancy', 'Assistant Professor', 'FAC-1008'),
  ('dyumul@hau.edu.ph',        'Yumul',        'Dennis',    'F', 'School of Business and Accountancy', 'Senior Lecturer',     'FAC-1009'),
  ('cpineda@hau.edu.ph',       'Pineda',       'Carmela',   'V', 'School of Business and Accountancy', 'Instructor',          'FAC-1010'),

  -- School of Engineering and Architecture
  ('adizon@hau.edu.ph',        'Dizon',        'Alfredo',   'G', 'School of Engineering and Architecture', 'Professor',           'FAC-1011'),
  ('mtolentino@hau.edu.ph',    'Tolentino',    'Maricar',   'P', 'School of Engineering and Architecture', 'Associate Professor', 'FAC-1012'),
  ('rmanalastas@hau.edu.ph',   'Manalastas',   'Renato',    'C', 'School of Engineering and Architecture', 'Assistant Professor', 'FAC-1013'),
  ('jsicat@hau.edu.ph',        'Sicat',        'Joanne',    'E', 'School of Engineering and Architecture', 'Senior Lecturer',     'FAC-1014'),
  ('egalang@hau.edu.ph',       'Galang',       'Elmer',     'B', 'School of Engineering and Architecture', 'Instructor',          'FAC-1015'),

  -- School of Arts and Sciences
  ('tnavarro@hau.edu.ph',      'Navarro',      'Teresa',    'I', 'School of Arts and Sciences', 'Professor',           'FAC-1016'),
  ('jramos@hau.edu.ph',        'Ramos',        'Julius',    'K', 'School of Arts and Sciences', 'Associate Professor', 'FAC-1017'),
  ('baquino@hau.edu.ph',       'Aquino',       'Bianca',    'N', 'School of Arts and Sciences', 'Assistant Professor', 'FAC-1018'),
  ('fsalazar@hau.edu.ph',      'Salazar',      'Ferdinand', 'O', 'School of Arts and Sciences', 'Senior Lecturer',     'FAC-1019'),
  ('mbondoc@hau.edu.ph',       'Bondoc',       'Michelle',  'A', 'School of Arts and Sciences', 'Instructor',          'FAC-1020'),

  -- School of Education
  ('rlacson@hau.edu.ph',       'Lacson',       'Rosario',   'D', 'School of Education', 'Professor',           'FAC-1021'),
  ('epunzalan@hau.edu.ph',     'Punzalan',     'Edgardo',   'M', 'School of Education', 'Associate Professor', 'FAC-1022'),
  ('afeliciano@hau.edu.ph',    'Feliciano',    'Angeline',  'C', 'School of Education', 'Assistant Professor', 'FAC-1023'),
  ('ngutierrez@hau.edu.ph',    'Gutierrez',    'Noel',      'P', 'School of Education', 'Senior Lecturer',     'FAC-1024'),
  ('dsarmiento@hau.edu.ph',    'Sarmiento',    'Divina',    'L', 'School of Education', 'Instructor',          'FAC-1025'),

  -- School of Nursing and Allied Medical Sciences
  ('icastillo@hau.edu.ph',     'Castillo',     'Imelda',    'R', 'School of Nursing and Allied Medical Sciences', 'Professor',           'FAC-1026'),
  ('aalmazan@hau.edu.ph',      'Almazan',      'Arnold',    'S', 'School of Nursing and Allied Medical Sciences', 'Associate Professor', 'FAC-1027'),
  ('kroxas@hau.edu.ph',        'Roxas',        'Katrina',   'J', 'School of Nursing and Allied Medical Sciences', 'Assistant Professor', 'FAC-1028'),
  ('mfernandez@hau.edu.ph',    'Fernandez',    'Miguel',    'A', 'School of Nursing and Allied Medical Sciences', 'Senior Lecturer',     'FAC-1029'),
  ('sbuenaventura@hau.edu.ph', 'Buenaventura', 'Sheila',    'M', 'School of Nursing and Allied Medical Sciences', 'Instructor',          'FAC-1030'),

  -- School of Hospitality and Tourism Management
  ('lagustin@hau.edu.ph',      'Agustin',      'Lorna',     'B', 'School of Hospitality and Tourism Management', 'Professor',           'FAC-1031'),
  ('vpanganiban@hau.edu.ph',   'Panganiban',   'Victor',    'E', 'School of Hospitality and Tourism Management', 'Associate Professor', 'FAC-1032'),
  ('rquiambao@hau.edu.ph',     'Quiambao',     'Rhea',      'T', 'School of Hospitality and Tourism Management', 'Assistant Professor', 'FAC-1033'),
  ('jmiranda@hau.edu.ph',      'Miranda',      'Jomar',     'C', 'School of Hospitality and Tourism Management', 'Senior Lecturer',     'FAC-1034'),
  ('ctorres@hau.edu.ph',       'Torres',       'Cecilia',   'G', 'School of Hospitality and Tourism Management', 'Instructor',          'FAC-1035'),

  -- School of Criminology
  ('rbulanadi@hau.edu.ph',     'Bulanadi',     'Rogelio',   'P', 'School of Criminology', 'Professor',           'FAC-1036'),
  ('mespino@hau.edu.ph',       'Espino',       'Marlon',    'D', 'School of Criminology', 'Associate Professor', 'FAC-1037'),
  ('jrivera@hau.edu.ph',       'Rivera',       'Jenny',     'F', 'School of Criminology', 'Assistant Professor', 'FAC-1038'),
  ('hcabrera@hau.edu.ph',      'Cabrera',      'Hector',    'L', 'School of Criminology', 'Senior Lecturer',     'FAC-1039'),
  ('psoriano@hau.edu.ph',      'Soriano',      'Patricia',  'N', 'School of Criminology', 'Instructor',          'FAC-1040');

-- 1. Auth users, with the shared demo password hashed the way GoTrue hashes it
--    (bcrypt). The on_auth_user_created trigger turns each one into a
--    public.profiles row, using the metadata built here.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select '00000000-0000-0000-0000-000000000000',
       gen_random_uuid(),
       'authenticated',
       'authenticated',
       m.email,
       extensions.crypt('Adviser@2026', extensions.gen_salt('bf')),
       now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object(
         'role',             'adviser',
         'full_name',        m.last_name || ', ' || m.first_name ||
                             coalesce(' ' || m.middle_initial || '.', ''),
         'last_name',        m.last_name,
         'first_name',       m.first_name,
         'middle_initial',   m.middle_initial,
         'department',       m.department,
         'employee_id',      m.employee_id,
         'faculty_position', m.faculty_position
       ),
       now(),
       now()
  from mock_advisers m
 where not exists (select 1 from auth.users u where u.email = m.email);

-- 2. GoTrue reads these four columns into plain Go strings, so a NULL in any of
--    them makes every sign-in fail with "Database error querying schema". The
--    normal sign-up path writes '' instead; a hand-seeded row has to do the same.
update auth.users u
   set confirmation_token     = coalesce(u.confirmation_token, ''),
       recovery_token         = coalesce(u.recovery_token, ''),
       email_change_token_new = coalesce(u.email_change_token_new, ''),
       email_change           = coalesce(u.email_change, '')
  from mock_advisers m
 where m.email = u.email;

-- 3. The email identity GoTrue expects alongside a password user.
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
select u.id::text,
       u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email',
       now(),
       now()
  from auth.users u
  join mock_advisers m on m.email = u.email
 where not exists (
         select 1 from auth.identities i
          where i.user_id = u.id and i.provider = 'email'
       );

-- 4. Mark the profiles finished, so /api/auth/login lets them in and the
--    adviser directory lists them. (The trigger filled in the rest.)
update public.profiles p
   set role                      = 'adviser',
       full_name                 = m.last_name || ', ' || m.first_name ||
                                   coalesce(' ' || m.middle_initial || '.', ''),
       last_name                 = m.last_name,
       first_name                = m.first_name,
       middle_initial            = m.middle_initial,
       department                = m.department,
       employee_id               = m.employee_id,
       faculty_position          = m.faculty_position,
       student_id                = null,
       course                    = null,
       year_level                = null,
       email_verified_at         = coalesce(p.email_verified_at, now()),
       registration_completed_at = coalesce(p.registration_completed_at, now())
  from mock_advisers m
 where p.email = m.email;

commit;
