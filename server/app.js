/**
 * ConsultTrack API server
 * -----------------------
 * Express + node-postgres (parameterized SQL) + Supabase Auth (Email OTP).
 *
 * Auth model: Supabase issues the 6-digit code and the JWT; this server verifies
 * the incoming bearer token with `supabase.auth.getUser()` and then talks to
 * Postgres directly. Every query below is parameterized -- no string building.
 */

import 'dotenv/config';
import dns from 'node:dns';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

// Supabase's pooler hostnames resolve to both IPv6 and IPv4. Node 18+ returns
// whatever DNS lists first, which is often the AAAA record -- and serverless
// platforms frequently have no IPv6 egress, so the connection dies with
// ENETUNREACH. Pinning IPv4 makes the choice deterministic.
dns.setDefaultResultOrder('ipv4first');

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  DATABASE_URL,
  CLIENT_ORIGIN = 'http://localhost:5173',
  // Serverless runtimes give every invocation its own container, so a large pool
  // there just burns Postgres connections. Set PG_POOL_MAX=1 on Vercel.
  PG_POOL_MAX = 10,
  // Comma-separated addresses allowed to register despite not being HAU ones.
  // An entry may name the role it should get: "you@gmail.com:adviser".
  // Leave empty in production.
  AUTH_EMAIL_ALLOWLIST = '',
  // Consultation hours are wall-clock campus time: an adviser free at 1 PM means
  // 1 PM in Angeles City, whatever the server's own clock is set to. Every
  // conversion between a weekly block and a real instant goes through this.
  CAMPUS_TIMEZONE = 'Asia/Manila',
} = process.env;

for (const [key, value] of Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY, DATABASE_URL })) {
  if (!value) {
    throw new Error(`[config] Missing required environment variable: ${key}`);
  }
}

/* -------------------------------------------------------------- clients -- */

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase terminates TLS with its own CA
  max: Number(PG_POOL_MAX),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

/* ---------------------------------------------------------------- app ---- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(cors({ origin: CLIENT_ORIGIN.split(',').map((o) => o.trim()), credentials: true }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;

// Sign-up is limited to HAU Google Workspace accounts, and the domain also
// decides the role: students hold addresses on the student subdomain, faculty
// and advisers on the main one. Nothing in the request can override this.
const STUDENT_DOMAIN = 'student.hau.edu.ph';
const FACULTY_DOMAIN = 'hau.edu.ph';
const HAU_DOMAINS = [STUDENT_DOMAIN, FACULTY_DOMAIN];
const HAU_EMAIL_HINT = 'Use your HAU email address (@student.hau.edu.ph or @hau.edu.ph).';

/*
 * Individual addresses that skip the domain check, for demos and testing.
 * Each entry is "address" or "address:role" -- the second form is how a
 * non-HAU test address can be registered as an adviser, since it has no
 * @hau.edu.ph domain to derive the role from.
 *
 *   AUTH_EMAIL_ALLOWLIST=you@gmail.com:adviser,panelist@gmail.com
 */
const EMAIL_ALLOWLIST = new Map(
  AUTH_EMAIL_ALLOWLIST.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const [address, role] = entry.split(':');
      return [address.trim(), role?.trim() === 'adviser' ? 'adviser' : 'student'];
    })
    .filter(([address]) => address),
);

// Loose on purpose - confirm HAU's real student-number format and tighten this.
const STUDENT_ID_RE = /^[0-9-]{6,20}$/;
// Faculty numbers vary more than student ones, so letters are allowed too.
const EMPLOYEE_ID_RE = /^[A-Za-z0-9-]{4,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* --------------------------------------------------------- auth middleware */

async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw new HttpError(401, 'Missing access token.');

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) throw new HttpError(401, 'Invalid or expired session.');

    const { rows } = await pool.query(
      `select ${PROFILE_COLUMNS} from public.profiles where id = $1`,
      [data.user.id],
    );

    req.user = data.user;
    req.profile = rows[0] ?? {
      id: data.user.id,
      full_name: null,
      email: data.user.email,
      role: 'student',
      group_name: null,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------ auth routes */

/*
 * Registration is three steps, in this order:
 *   1. POST /api/auth/start           email  -> account stub + 6-digit code
 *   2. POST /api/auth/verify-code     code   -> session (profile still empty)
 *   3. POST /api/auth/complete-profile details + password -> ready to sign in
 *
 * Verifying the address first means nobody fills a long form for an inbox they
 * do not control.
 */

const PROFILE_COLUMNS = `id, full_name, email, role, group_name,
                         last_name, first_name, middle_initial,
                         student_id, department, course, year_level,
                         employee_id, faculty_position,
                         email_verified_at, registration_completed_at`;

const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year'];
const FACULTY_POSITIONS = [
  'Professor',
  'Associate Professor',
  'Assistant Professor',
  'Senior Lecturer',
  'Lecturer',
  'Instructor',
];

/** "Dela Cruz, Juan M." */
function composeFullName({ lastName, firstName, middleInitial }) {
  const initial = middleInitial ? ` ${middleInitial.toUpperCase()}.` : '';
  return `${lastName}, ${firstName}${initial}`;
}

/**
 * Sends the 6-digit code through the Magic Link template.
 *
 * Requires "Confirm email" to be OFF in Supabase. With it on, a brand-new
 * address gets the signup-confirmation template instead -- which in this project
 * delivers a link rather than a code.
 */
async function sendAccessCode(email, { createUser }) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: createUser },
  });
  if (error) {
    const status = error.status === 429 ? 429 : 400;
    throw new HttpError(status, error.message || 'Could not send the access code.');
  }
}

/**
 * The account type a given address gets: faculty domain means adviser, and an
 * allowlisted test address gets whatever role its entry names (student unless
 * it says otherwise).
 */
function roleForEmail(email) {
  const address = String(email).trim().toLowerCase();
  if (EMAIL_ALLOWLIST.has(address)) return EMAIL_ALLOWLIST.get(address);
  return address.endsWith(`@${FACULTY_DOMAIN}`) ? 'adviser' : 'student';
}

/**
 * Normalizes the address and enforces the HAU domain rule.
 *
 * Only the registration routes call this. Sign-in checks the format alone so
 * that an account created before the rule existed is not locked out.
 */
function requireHauEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (EMAIL_ALLOWLIST.has(email)) return email;

  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!HAU_DOMAINS.includes(domain)) throw new HttpError(400, HAU_EMAIL_HINT);
  return email;
}

/** A profile counts as registered once the details step has been submitted. */
function isComplete(profile) {
  return Boolean(profile?.registration_completed_at);
}

/**
 * POST /api/auth/start
 * Body: { email }
 * Step 1 of registration: creates the account stub and emails the code.
 */
app.post(
  '/api/auth/start',
  asyncRoute(async (req, res) => {
    const email = requireHauEmail(req.body?.email);

    const { rows } = await pool.query(
      `select registration_completed_at from public.profiles where email = $1`,
      [email],
    );
    if (rows[0]?.registration_completed_at) {
      throw new HttpError(409, 'That email is already registered. Sign in instead.');
    }

    await sendAccessCode(email, { createUser: true });
    res.json({ ok: true, message: `We sent a 6-digit code to ${email}.` });
  }),
);

/**
 * POST /api/auth/send-code
 * Body: { email } - resends the code for an in-progress registration.
 */
app.post(
  '/api/auth/send-code',
  asyncRoute(async (req, res) => {
    const email = requireHauEmail(req.body?.email);

    await sendAccessCode(email, { createUser: true });
    res.json({ ok: true, message: `Access code sent to ${email}.` });
  }),
);

/**
 * POST /api/auth/verify-code
 * Body: { email, code }
 * Step 2: returns a session. `profileComplete` tells the client whether to show
 * the details form or go straight to the dashboard.
 */
app.post(
  '/api/auth/verify-code',
  asyncRoute(async (req, res) => {
    const email = requireHauEmail(req.body?.email);
    const code = String(req.body?.code ?? '').trim();

    if (!CODE_RE.test(code)) throw new HttpError(400, 'The access code must be 6 digits.');

    const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
    if (error || !data?.session) {
      throw new HttpError(401, error?.message || 'That access code is invalid or has expired.');
    }

    // The role is re-derived on every code, but only re-stamped while the
    // registration is unfinished -- an existing adviser is never demoted.
    const { rows } = await pool.query(
      `insert into public.profiles (id, email, full_name, role, email_verified_at)
            values ($1, $2, $3, $4, now())
       on conflict (id) do update
              set email = excluded.email,
                  role = case
                           when public.profiles.registration_completed_at is null
                           then excluded.role
                           else public.profiles.role
                         end,
                  email_verified_at = coalesce(public.profiles.email_verified_at, now())
         returning ${PROFILE_COLUMNS}`,
      [data.user.id, data.user.email, email.split('@')[0], roleForEmail(email)],
    );

    res.json({
      ok: true,
      profileComplete: isComplete(rows[0]),
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
      profile: rows[0],
    });
  }),
);

/**
 * POST /api/auth/complete-profile
 * Body (student): { lastName, firstName, middleInitial?, studentId, department,
 *                   course, yearLevel, password, refresh_token }
 * Body (adviser): { lastName, firstName, middleInitial?, employeeId, department,
 *                   facultyPosition?, password, refresh_token }
 * Header: Authorization: Bearer <access_token from verify-code>
 *
 * Step 3: sets the password on the Supabase user and fills in the profile. Which
 * fields are required depends on the role, and the role comes from the verified
 * address rather than the request body -- a student cannot ask to be an adviser.
 */
app.post(
  '/api/auth/complete-profile',
  requireAuth,
  asyncRoute(async (req, res) => {
    const role = roleForEmail(req.profile.email);
    const isAdviser = role === 'adviser';

    const password = String(req.body?.password ?? '');
    const lastName = String(req.body?.lastName ?? '').trim();
    const firstName = String(req.body?.firstName ?? '').trim();
    const middleInitial = String(req.body?.middleInitial ?? '').trim().slice(0, 1);
    const department = String(req.body?.department ?? '').trim();
    const refreshToken = String(req.body?.refresh_token ?? '');

    // Student-only fields.
    const studentId = isAdviser ? '' : String(req.body?.studentId ?? '').trim();
    const course = isAdviser ? '' : String(req.body?.course ?? '').trim();
    const yearLevel = isAdviser ? '' : String(req.body?.yearLevel ?? '').trim();

    // Adviser-only fields.
    const employeeId = isAdviser ? String(req.body?.employeeId ?? '').trim() : '';
    const facultyPosition = isAdviser ? String(req.body?.facultyPosition ?? '').trim() : '';

    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (!lastName) throw new HttpError(400, 'Last name is required.');
    if (!firstName) throw new HttpError(400, 'First name is required.');
    if (!department) throw new HttpError(400, 'Department is required.');
    if (!refreshToken) throw new HttpError(400, 'Missing session. Start the sign-up again.');

    if (isAdviser) {
      if (!EMPLOYEE_ID_RE.test(employeeId)) {
        throw new HttpError(400, 'Enter a valid faculty ID (4-20 letters, digits or dashes).');
      }
      if (facultyPosition && !FACULTY_POSITIONS.includes(facultyPosition)) {
        throw new HttpError(400, 'Select a valid academic position.');
      }
    } else {
      if (!STUDENT_ID_RE.test(studentId)) {
        throw new HttpError(400, 'Enter a valid student ID (6-20 digits or dashes).');
      }
      if (!course) throw new HttpError(400, 'Course is required.');
      if (!YEAR_LEVELS.includes(yearLevel)) throw new HttpError(400, 'Select your year level.');
    }

    const idColumn = isAdviser ? 'employee_id' : 'student_id';
    const { rows: clash } = await pool.query(
      `select 1 from public.profiles where ${idColumn} = $1 and id <> $2 limit 1`,
      [isAdviser ? employeeId : studentId, req.profile.id],
    );
    if (clash.length) {
      throw new HttpError(
        409,
        `That ${isAdviser ? 'faculty' : 'student'} ID is already registered.`,
      );
    }

    const fullName = composeFullName({ lastName, firstName, middleInitial });

    // updateUser acts on the *caller's* session, so this needs a client carrying
    // their tokens rather than the shared anonymous one.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const { data: sessionData, error: sessionError } = await userClient.auth.setSession({
      access_token: req.headers.authorization.slice(7).trim(),
      refresh_token: refreshToken,
    });
    if (sessionError || !sessionData?.session) {
      throw new HttpError(401, 'Your session expired. Start the sign-up again.');
    }

    const { error: updateError } = await userClient.auth.updateUser({
      password,
      data: {
        role,
        full_name: fullName,
        last_name: lastName,
        first_name: firstName,
        middle_initial: middleInitial,
        department,
        ...(isAdviser
          ? { employee_id: employeeId, faculty_position: facultyPosition }
          : { student_id: studentId, course, year_level: yearLevel }),
      },
    });
    if (updateError) {
      throw new HttpError(400, updateError.message || 'Could not save your password.');
    }

    const { rows } = await pool.query(
      `update public.profiles
          set full_name = $2, last_name = $3, first_name = $4, middle_initial = $5,
              student_id = $6, department = $7, course = $8, year_level = $9,
              employee_id = $10, faculty_position = $11,
              role = $12,
              email_verified_at = coalesce(email_verified_at, now()),
              registration_completed_at = now()
        where id = $1
    returning ${PROFILE_COLUMNS}`,
      [req.profile.id, fullName, lastName, firstName, middleInitial || null,
       studentId || null, department, course || null, yearLevel || null,
       employeeId || null, facultyPosition || null, role],
    );

    res.json({
      ok: true,
      session: {
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
        expires_at: sessionData.session.expires_at,
      },
      profile: rows[0],
    });
  }),
);

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');

    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (!password) throw new HttpError(400, 'Enter your password.');

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data?.session) throw new HttpError(401, 'Incorrect email or password.');

    const { rows } = await pool.query(
      `select ${PROFILE_COLUMNS} from public.profiles where id = $1`,
      [data.user.id],
    );

    if (!isComplete(rows[0])) {
      throw new HttpError(403, 'Finish creating your account first, then sign in.');
    }

    res.json({
      ok: true,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
      profile: rows[0],
    });
  }),
);

/** GET /api/me - the signed-in user's profile. */
app.get(
  '/api/me',
  requireAuth,
  asyncRoute(async (req, res) => res.json({ profile: req.profile })),
);

/* ---------------------------------------------------------- data routes -- */

/**
 * Upcoming scheduled consultations the caller may see: advisers get the ones
 * they advise, students the ones booked for their thesis group.
 *
 * `status = 'scheduled'` is what makes the approval step real -- a request the
 * adviser has not accepted yet is still 'pending' and never appears here, so it
 * cannot be mistaken for an official session.
 */
async function upcomingConsultations(profile, limit) {
  const { id, role, group_name: groupName } = profile;

  const { rows } = await pool.query(
    `select c.id,
            c.group_name,
            c.topic,
            c.location,
            c.meeting_date,
            c.status,
            p.full_name as adviser_name,
            p.email     as adviser_email
       from public.consultations c
       left join public.profiles p on p.id = c.adviser_id
      where c.status = 'scheduled'
        and c.meeting_date >= now()
        and (
              ($2 = 'adviser' and c.adviser_id = $1)
           or ($2 <> 'adviser' and (c.group_name = $3 or c.created_by = $1))
        )
      order by c.meeting_date asc
      limit $4`,
    [id, role, groupName, limit],
  );
  return rows;
}

/**
 * GET /api/consultations/next
 * The soonest scheduled consultation, or null.
 */
app.get(
  '/api/consultations/next',
  requireAuth,
  asyncRoute(async (req, res) => {
    const rows = await upcomingConsultations(req.profile, 1);
    res.json({ consultation: rows[0] ?? null });
  }),
);

/**
 * GET /api/consultations?limit=10
 * The caller's upcoming schedule. Advisers lean on this the most: it is the list
 * of sessions they have been booked for.
 */
app.get(
  '/api/consultations',
  requireAuth,
  asyncRoute(async (req, res) => {
    const requested = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 10;

    res.json({ consultations: await upcomingConsultations(req.profile, limit) });
  }),
);

/**
 * GET /api/consultations/requests
 *
 * The approval inbox, and the notification the adviser sees. For an adviser it
 * is every request still waiting on their decision. For a student it is their
 * group's own requests: the ones still pending, plus any declined in the last
 * fortnight, which is how they find out the answer was no.
 */
app.get(
  '/api/consultations/requests',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { id, role, group_name: groupName } = req.profile;

    const { rows } = await pool.query(
      `select c.id,
              c.group_name,
              c.topic,
              c.location,
              c.meeting_date,
              c.status,
              c.created_at,
              c.responded_at,
              c.decline_reason,
              s.full_name  as requester_name,
              s.email      as requester_email,
              s.course     as requester_course,
              s.year_level as requester_year_level,
              p.full_name  as adviser_name,
              p.email      as adviser_email
         from public.consultations c
         left join public.profiles s on s.id = c.created_by
         left join public.profiles p on p.id = c.adviser_id
        where (
                ($2 = 'adviser' and c.adviser_id = $1 and c.status = 'pending')
             or ($2 <> 'adviser'
                 and (c.group_name = $3 or c.created_by = $1)
                 and (
                       c.status = 'pending'
                    or (c.status = 'declined' and c.responded_at > now() - interval '14 days')
                 ))
              )
        order by c.meeting_date asc`,
      [id, role, groupName],
    );

    res.json({ requests: rows });
  }),
);

/**
 * PATCH /api/consultations/:id/decision
 * Body: { decision: 'approved' | 'declined', reason? }
 *
 * The adviser's answer to a request. Approving is what makes a consultation
 * official ('scheduled'); declining records the reason so the student sees why.
 * Only the adviser the request was addressed to may answer it, and only while it
 * is still pending -- so a second click cannot undo a decision.
 */
app.patch(
  '/api/consultations/:id/decision',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role !== 'adviser') {
      throw new HttpError(403, 'Only the adviser can approve a consultation request.');
    }
    if (!UUID_RE.test(String(req.params.id))) {
      throw new HttpError(400, 'That request is not valid.');
    }

    const decision = String(req.body?.decision ?? '').trim();
    if (!['approved', 'declined'].includes(decision)) {
      throw new HttpError(400, 'Decision must be approved or declined.');
    }

    const reason = String(req.body?.reason ?? '').trim().slice(0, 500);
    if (decision === 'declined' && !reason) {
      throw new HttpError(400, 'Give the group a reason for declining.');
    }

    const { rows } = await pool.query(
      `update public.consultations
          set status         = $3,
              responded_at   = now(),
              decline_reason = $4
        where id = $1
          and adviser_id = $2
          and status = 'pending'
    returning id, group_name, topic, location, meeting_date, status,
              responded_at, decline_reason`,
      [req.params.id, req.profile.id, decision === 'approved' ? 'scheduled' : 'declined',
       decision === 'declined' ? reason : null],
    );

    if (!rows[0]) {
      // Either it is not theirs, or somebody already answered it.
      throw new HttpError(404, 'That request is no longer pending.');
    }

    res.json({ consultation: rows[0] });
  }),
);

/**
 * GET /api/advisers
 * The adviser directory a student picks from when booking. Only finished
 * registrations appear, so a half-created account cannot be booked with.
 *
 * The list is scoped to the caller's own department: a School of Computing
 * student sees the School of Computing advisers and nobody else. `scoped` says
 * whether that filter was applied -- it is false only for the rare profile with
 * no department recorded (an account created before the field existed), which
 * falls back to the full directory rather than an empty screen.
 */
app.get(
  '/api/advisers',
  requireAuth,
  asyncRoute(async (req, res) => {
    const department = req.profile.department ?? null;

    const { rows } = await pool.query(
      `select id, full_name, email, department, faculty_position
         from public.profiles
        where role = 'adviser'
          and registration_completed_at is not null
          and ($1::text is null or department = $1)
        order by full_name asc`,
      [department],
    );

    res.json({ advisers: rows, department, scoped: department !== null });
  }),
);

/* --------------------------------------------------- consultation hours -- */

/*
 * Availability turns booking from a guess into a pick.
 *
 * An adviser publishes recurring weekly blocks -- "Wednesdays 1-4 PM, 30-minute
 * slots, Faculty Room 204". A student opens the booking form, picks a date, and
 * sees the slots that block produces, with the ones already taken struck out.
 * The request then lands on a time the adviser has already said they can take,
 * instead of on a time the adviser has to decline.
 *
 * The stored times are wall-clock (`time`, no zone) because a weekly block means
 * the same campus hour every week. CAMPUS_TIMEZONE is what turns one of those
 * plus a calendar date into a real instant.
 */

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SLOT_CHOICES = [15, 20, 30, 45, 60, 90, 120];
/** Used to space out bookings for an adviser who has published no hours. */
const DEFAULT_SLOT_MINUTES = 30;

const AVAILABILITY_COLUMNS = `id, weekday, to_char(start_time, 'HH24:MI') as start_time,
                              to_char(end_time, 'HH24:MI') as end_time,
                              slot_minutes, location, is_active`;

/** GET /api/availability - the caller's own published consultation hours. */
app.get(
  '/api/availability',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role !== 'adviser') {
      throw new HttpError(403, 'Only advisers publish consultation hours.');
    }

    const { rows } = await pool.query(
      `select ${AVAILABILITY_COLUMNS}
         from public.adviser_availability
        where adviser_id = $1
        order by weekday asc, start_time asc`,
      [req.profile.id],
    );

    res.json({ availability: rows, timezone: CAMPUS_TIMEZONE });
  }),
);

/**
 * POST /api/availability
 * Body: { weekday: 0-6, start_time: "13:00", end_time: "16:00",
 *         slot_minutes?: 30, location? }
 */
app.post(
  '/api/availability',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role !== 'adviser') {
      throw new HttpError(403, 'Only advisers publish consultation hours.');
    }

    const weekday = Number.parseInt(req.body?.weekday, 10);
    const startTime = String(req.body?.start_time ?? '').trim();
    const endTime = String(req.body?.end_time ?? '').trim();
    const slotMinutes = Number.parseInt(req.body?.slot_minutes ?? DEFAULT_SLOT_MINUTES, 10);
    const location = String(req.body?.location ?? '').trim().slice(0, 200) || null;

    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new HttpError(400, 'Pick a day of the week.');
    }
    if (!HHMM_RE.test(startTime) || !HHMM_RE.test(endTime)) {
      throw new HttpError(400, 'Start and end time must look like 13:00.');
    }
    if (!SLOT_CHOICES.includes(slotMinutes)) {
      throw new HttpError(400, `Slot length must be one of ${SLOT_CHOICES.join(', ')} minutes.`);
    }
    if (endTime <= startTime) {
      // Lexical compare is safe: both are zero-padded HH:MM.
      throw new HttpError(400, 'The end time has to be after the start time.');
    }

    const minutesLong =
      (Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3))) -
      (Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3)));
    if (minutesLong < slotMinutes) {
      throw new HttpError(
        400,
        `That block is only ${minutesLong} minutes long - too short for a ${slotMinutes}-minute slot.`,
      );
    }

    // Overlapping blocks on the same day would offer the same hour twice.
    const { rows: overlap } = await pool.query(
      `select 1 from public.adviser_availability
        where adviser_id = $1 and weekday = $2
          and start_time < $4::time and end_time > $3::time
        limit 1`,
      [req.profile.id, weekday, startTime, endTime],
    );
    if (overlap.length) {
      throw new HttpError(409, 'That overlaps consultation hours you already published.');
    }

    const { rows } = await pool.query(
      `insert into public.adviser_availability
              (adviser_id, weekday, start_time, end_time, slot_minutes, location)
       values ($1, $2, $3::time, $4::time, $5, $6)
    returning ${AVAILABILITY_COLUMNS}`,
      [req.profile.id, weekday, startTime, endTime, slotMinutes, location],
    );

    res.status(201).json({ availability: rows[0] });
  }),
);

/**
 * DELETE /api/availability/:id
 * Removes a block. Sessions already booked out of it are untouched - they are
 * real consultations now, not slots.
 */
app.delete(
  '/api/availability/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role !== 'adviser') {
      throw new HttpError(403, 'Only advisers publish consultation hours.');
    }
    if (!UUID_RE.test(String(req.params.id))) {
      throw new HttpError(400, 'That block is not valid.');
    }

    const { rows } = await pool.query(
      `delete from public.adviser_availability
        where id = $1 and adviser_id = $2
    returning id`,
      [req.params.id, req.profile.id],
    );

    if (!rows[0]) throw new HttpError(404, 'Those consultation hours no longer exist.');
    res.json({ ok: true, id: rows[0].id });
  }),
);

/**
 * GET /api/advisers/:id/slots?date=YYYY-MM-DD
 *
 * The booking picker. Returns every slot the adviser's blocks produce on that
 * date, each flagged `taken` when a pending or scheduled session already sits in
 * it, plus `weekdays` - the days of the week they hold hours at all, so the form
 * can steer the student to a day that has any.
 */
app.get(
  '/api/advisers/:id/slots',
  requireAuth,
  asyncRoute(async (req, res) => {
    const adviserId = String(req.params.id);
    if (!UUID_RE.test(adviserId)) throw new HttpError(400, 'That adviser is not valid.');

    const date = String(req.query.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpError(400, 'Pass the date as YYYY-MM-DD.');
    }

    // Same department rule as the directory and the booking route: a student
    // cannot enumerate another school's advisers by guessing ids.
    const { rows: adviser } = await pool.query(
      `select department from public.profiles
        where id = $1 and role = 'adviser' and registration_completed_at is not null
        limit 1`,
      [adviserId],
    );
    if (!adviser.length) throw new HttpError(404, 'That adviser was not found.');

    const bookerDepartment = req.profile.department;
    if (bookerDepartment && adviser[0].department && adviser[0].department !== bookerDepartment) {
      throw new HttpError(403, `You can only book advisers from ${bookerDepartment}.`);
    }

    const [{ rows: slots }, { rows: days }] = await Promise.all([
      pool.query(
        `with args as (
           select $1::uuid as adviser_id, $2::date as on_date, $3::text as tz
         ), block as (
           select a.slot_minutes,
                  a.location,
                  generate_series(
                    ((g.on_date + a.start_time) at time zone g.tz),
                    ((g.on_date + a.end_time) at time zone g.tz)
                      - make_interval(mins => a.slot_minutes),
                    make_interval(mins => a.slot_minutes)
                  ) as slot_start
             from args g
             join public.adviser_availability a
               on a.adviser_id = g.adviser_id
              and a.is_active
              and a.weekday = extract(dow from g.on_date)
         )
         select b.slot_start,
                b.slot_start + make_interval(mins => b.slot_minutes) as slot_end,
                b.slot_minutes,
                b.location,
                exists (
                  select 1
                    from public.consultations c, args g
                   where c.adviser_id = g.adviser_id
                     and c.status in ('pending', 'scheduled')
                     and c.meeting_date >= b.slot_start
                     and c.meeting_date <  b.slot_start
                                           + make_interval(mins => b.slot_minutes)
                ) as taken
           from block b
          where b.slot_start > now()
          order by b.slot_start asc`,
        [adviserId, date, CAMPUS_TIMEZONE],
      ),
      pool.query(
        `select distinct weekday from public.adviser_availability
          where adviser_id = $1 and is_active
          order by weekday asc`,
        [adviserId],
      ),
    ]);

    res.json({
      slots,
      weekdays: days.map((row) => row.weekday),
      timezone: CAMPUS_TIMEZONE,
    });
  }),
);

/**
 * Whether `meetingDate` is a time this adviser can actually be booked for.
 *
 * Two separate rules, and the first only applies once the adviser has published
 * something: an adviser with no hours on file keeps the old free-form booking,
 * so nobody is locked out by a feature they have not set up yet.
 *
 *   1. published hours  -> the time must sit on a slot boundary inside a block
 *   2. always           -> the slot must not already be spoken for
 */
async function slotStatus(adviserId, meetingDate) {
  const { rows } = await pool.query(
    `with req as (
       select $1::uuid as adviser_id,
              $2::timestamptz as at,
              ($2::timestamptz at time zone $3) as local_ts
     ), match as (
       select a.slot_minutes, a.location
         from public.adviser_availability a, req r
        where a.adviser_id = r.adviser_id
          and a.is_active
          and a.weekday = extract(dow from r.local_ts)
          and r.local_ts::time >= a.start_time
          and r.local_ts::time <  a.end_time
          -- Landing mid-slot would silently shift every later slot along.
          and mod(
                extract(epoch from (r.local_ts::time - a.start_time))::int,
                a.slot_minutes * 60
              ) = 0
        limit 1
     )
     select (select count(*)::int
               from public.adviser_availability a, req r
              where a.adviser_id = r.adviser_id and a.is_active)  as block_count,
            (select slot_minutes from match)                      as slot_minutes,
            (select location from match)                          as slot_location,
            (select count(*)::int
               from public.consultations c, req r
              where c.adviser_id = r.adviser_id
                and c.status in ('pending', 'scheduled')
                and c.meeting_date > r.at
                      - make_interval(mins => coalesce((select slot_minutes from match), $4))
                and c.meeting_date < r.at
                      + make_interval(mins => coalesce((select slot_minutes from match), $4))
            )                                                     as clashes`,
    [adviserId, meetingDate.toISOString(), CAMPUS_TIMEZONE, DEFAULT_SLOT_MINUTES],
  );

  const row = rows[0];
  return {
    publishesHours: row.block_count > 0,
    insideBlock: row.slot_minutes !== null,
    slotLocation: row.slot_location,
    taken: row.clashes > 0,
  };
}

/**
 * GET /api/tasks/pending
 * Every open action item the caller is allowed to see.
 */
app.get(
  '/api/tasks/pending',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { id, role, group_name: groupName } = req.profile;

    const { rows } = await pool.query(
      `select a.id,
              a.task_description,
              a.status,
              a.created_at,
              a.consultation_id,
              to_char(a.due_date, 'YYYY-MM-DD') as due_date,
              c.topic        as consultation_topic,
              c.meeting_date as consultation_date,
              c.group_name,
              p.full_name    as assignee_name
         from public.action_items a
         join public.consultations c on c.id = a.consultation_id
         left join public.profiles p on p.id = a.assignee_id
        where a.status = 'pending'
          and (
                ($2 = 'adviser' and c.adviser_id = $1)
             or ($2 <> 'adviser' and (a.assignee_id = $1 or c.group_name = $3))
          )
        order by c.meeting_date asc nulls last, a.created_at asc`,
      [id, role, groupName],
    );

    res.json({ tasks: rows });
  }),
);

/**
 * POST /api/consultations
 * Body: { topic, meeting_date (ISO), location?, group_name?, adviser_id? }
 *
 * A student's booking is a *request*: it is created 'pending' and waits for the
 * adviser's decision. Read the returned `status` to tell the two apart.
 */
app.post(
  '/api/consultations',
  requireAuth,
  asyncRoute(async (req, res) => {
    const topic = String(req.body?.topic ?? '').trim();
    const location = String(req.body?.location ?? '').trim() || null;
    const rawDate = String(req.body?.meeting_date ?? '').trim();
    const groupName = String(req.body?.group_name ?? req.profile.group_name ?? '').trim();

    if (!topic) throw new HttpError(400, 'A meeting agenda / topic is required.');
    if (topic.length > 500) throw new HttpError(400, 'The topic is too long (max 500 characters).');
    if (!groupName) {
      throw new HttpError(400, 'No thesis group on your profile - send group_name with the request.');
    }

    const meetingDate = new Date(rawDate);
    if (!rawDate || Number.isNaN(meetingDate.getTime())) {
      throw new HttpError(400, 'A valid meeting date and time is required.');
    }

    // An adviser booking for themselves is the default; a student names one.
    const adviserId =
      req.body?.adviser_id ?? (req.profile.role === 'adviser' ? req.profile.id : null);

    if (!adviserId) throw new HttpError(400, 'Choose the adviser for this consultation.');
    if (!UUID_RE.test(String(adviserId))) throw new HttpError(400, 'That adviser is not valid.');

    const { rows: adviser } = await pool.query(
      `select department from public.profiles
        where id = $1 and role = 'adviser' and registration_completed_at is not null
        limit 1`,
      [adviserId],
    );
    if (!adviser.length) {
      throw new HttpError(400, 'That adviser was not found. Pick one from the list.');
    }

    // The directory is already filtered by department; this is the same rule
    // enforced on the way in, so a hand-made request cannot reach across
    // schools. Profiles with no department on either side skip the check.
    const bookerDepartment = req.profile.department;
    if (bookerDepartment && adviser[0].department && adviser[0].department !== bookerDepartment) {
      throw new HttpError(403, `You can only book advisers from ${bookerDepartment}.`);
    }

    // Does the adviser's diary allow this time at all? An adviser booking their
    // own session is exempt from the published-hours rule -- those hours exist to
    // tell students when to ask, and the adviser is not asking anyone.
    const bookingSelf = adviserId === req.profile.id;
    const slot = await slotStatus(adviserId, meetingDate);

    if (!bookingSelf && slot.publishesHours && !slot.insideBlock) {
      throw new HttpError(
        409,
        'That time is outside the consultation hours your adviser published. Pick one of the open slots.',
      );
    }
    if (slot.taken) {
      throw new HttpError(
        409,
        bookingSelf
          ? 'You already have a session at that time.'
          : 'Somebody just took that slot. Pick another one.',
      );
    }

    // A student is asking; the adviser has to say yes before it counts. An
    // adviser booking one of their own groups is already the approver, so their
    // session is official the moment it is created.
    const status = bookingSelf ? 'scheduled' : 'pending';

    const { rows } = await pool.query(
      `insert into public.consultations
              (adviser_id, group_name, topic, location, meeting_date, status, created_by)
       values ($1, $2, $3, $4, $5, $7, $6)
    returning id, adviser_id, group_name, topic, location, meeting_date, status, created_at`,
      // A slot carries the room its block named, so a student who left the
      // location blank still gets "Faculty Room 204" on the booking.
      [adviserId, groupName, topic, location ?? slot.slotLocation, meetingDate.toISOString(),
       req.profile.id, status],
    );

    res.status(201).json({ consultation: rows[0] });
  }),
);

/* ------------------------------------------------- threads and wrap-up --- */

/*
 * Everything below hangs off one consultation, so everything below shares one
 * access rule -- the same predicate `upcomingConsultations`, the request inbox
 * and the task list already use: an adviser reaches the consultations they
 * advise, a student the ones booked for their group or created by them.
 *
 * That is also why threads are scoped to a consultation rather than to a
 * student/adviser pair. There is no standing group-to-adviser link in this
 * schema, so a pair has no natural scope; a consultation carries both sides and
 * its own permission rule already.
 */

/** The consultation, if this caller is allowed to see it. Throws otherwise. */
async function loadConsultationFor(profile, consultationId) {
  if (!UUID_RE.test(String(consultationId))) {
    throw new HttpError(400, 'That consultation is not valid.');
  }

  const { rows } = await pool.query(
    `select c.id, c.adviser_id, c.group_name, c.topic, c.location, c.meeting_date,
            c.status, c.created_by, c.created_at, c.decline_reason,
            c.minutes, c.completed_at,
            p.full_name as adviser_name,
            p.email     as adviser_email,
            s.full_name as requester_name,
            s.email     as requester_email
       from public.consultations c
       left join public.profiles p on p.id = c.adviser_id
       left join public.profiles s on s.id = c.created_by
      where c.id = $1
        and (
              ($3 = 'adviser' and c.adviser_id = $2)
           or ($3 <> 'adviser' and (c.group_name = $4 or c.created_by = $2))
        )
      limit 1`,
    [consultationId, profile.id, profile.role, profile.group_name],
  );

  if (!rows[0]) throw new HttpError(404, 'That consultation was not found.');
  return rows[0];
}

/**
 * GET /api/consultations/:id/messages
 *
 * The thread, oldest first, plus the consultation it belongs to and the people
 * an action item could be assigned to. Opening a thread marks it read up to the
 * newest message *returned* rather than to `now()`, so a message that lands
 * mid-request is still unread next time instead of being silently skipped.
 */
app.get(
  '/api/consultations/:id/messages',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    const { rows: messages } = await pool.query(
      `select m.id, m.body, m.created_at, m.sender_id,
              p.full_name as sender_name,
              p.role      as sender_role
         from public.consultation_messages m
         left join public.profiles p on p.id = m.sender_id
        where m.consultation_id = $1
        order by m.created_at asc, m.id asc`,
      [consultation.id],
    );

    const readThrough = messages.length
      ? messages[messages.length - 1].created_at
      : new Date();

    await pool.query(
      `insert into public.consultation_reads (consultation_id, profile_id, last_read_at)
            values ($1, $2, $3)
       on conflict (consultation_id, profile_id) do update
              set last_read_at = greatest(public.consultation_reads.last_read_at,
                                          excluded.last_read_at)`,
      [consultation.id, req.profile.id, readThrough],
    );

    res.json({ consultation, messages });
  }),
);

/**
 * POST /api/consultations/:id/messages
 * Body: { body }
 */
app.post(
  '/api/consultations/:id/messages',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    const body = String(req.body?.body ?? '').trim();
    if (!body) throw new HttpError(400, 'Write a message first.');
    if (body.length > 2000) {
      throw new HttpError(400, 'That message is too long (max 2000 characters).');
    }

    const { rows } = await pool.query(
      `insert into public.consultation_messages (consultation_id, sender_id, body)
            values ($1, $2, $3)
         returning id, body, created_at, sender_id`,
      [consultation.id, req.profile.id, body],
    );

    // Your own message is read the moment you send it.
    await pool.query(
      `insert into public.consultation_reads (consultation_id, profile_id, last_read_at)
            values ($1, $2, $3)
       on conflict (consultation_id, profile_id) do update
              set last_read_at = greatest(public.consultation_reads.last_read_at,
                                          excluded.last_read_at)`,
      [consultation.id, req.profile.id, rows[0].created_at],
    );

    res.status(201).json({
      message: {
        ...rows[0],
        sender_name: req.profile.full_name,
        sender_role: req.profile.role,
      },
    });
  }),
);

/**
 * GET /api/messages/unread
 *
 * The badge. A message counts as unread when somebody else sent it after the
 * caller last read that thread; a thread never opened counts every message.
 */
app.get(
  '/api/messages/unread',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { id, role, group_name: groupName } = req.profile;

    const { rows } = await pool.query(
      `select c.id as consultation_id, c.topic, count(m.id)::int as unread
         from public.consultations c
         join public.consultation_messages m on m.consultation_id = c.id
         left join public.consultation_reads r
                on r.consultation_id = c.id and r.profile_id = $1
        where (
                ($2 = 'adviser' and c.adviser_id = $1)
             or ($2 <> 'adviser' and (c.group_name = $3 or c.created_by = $1))
              )
          and m.sender_id <> $1
          and (r.last_read_at is null or m.created_at > r.last_read_at)
        group by c.id, c.topic
        order by count(m.id) desc`,
      [id, role, groupName],
    );

    res.json({
      total: rows.reduce((sum, row) => sum + row.unread, 0),
      threads: rows,
    });
  }),
);

/**
 * GET /api/consultations/history?limit=20
 *
 * Sessions that have already happened, newest first. A session the adviser
 * never wrapped up still appears -- it took place whether or not anyone wrote it
 * down, and surfacing it is how it gets finished.
 */
app.get(
  '/api/consultations/history',
  requireAuth,
  asyncRoute(async (req, res) => {
    const requested = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 20;

    const { id, role, group_name: groupName } = req.profile;

    const { rows } = await pool.query(
      `select c.id, c.group_name, c.topic, c.location, c.meeting_date, c.status,
              c.minutes, c.completed_at,
              p.full_name as adviser_name,
              p.email     as adviser_email,
              (select count(*)::int from public.action_items a
                where a.consultation_id = c.id)                     as task_count,
              (select count(*)::int from public.consultation_messages m
                where m.consultation_id = c.id)                     as message_count
         from public.consultations c
         left join public.profiles p on p.id = c.adviser_id
        where c.status in ('scheduled', 'completed')
          and (c.completed_at is not null or c.meeting_date < now())
          and (
                ($2 = 'adviser' and c.adviser_id = $1)
             or ($2 <> 'adviser' and (c.group_name = $3 or c.created_by = $1))
          )
        order by c.meeting_date desc
        limit $4`,
      [id, role, groupName, limit],
    );

    res.json({ consultations: rows });
  }),
);

/**
 * GET /api/consultations/:id
 *
 * One consultation, plus the people an action item could be assigned to. There
 * is no group membership table, so a group is whoever declares that group_name,
 * plus whoever made the booking -- who may never have set theirs.
 */
app.get(
  '/api/consultations/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    const { rows: members } = await pool.query(
      `select id, full_name, email
         from public.profiles
        where role = 'student'
          and (($1::text is not null and group_name = $1) or id = $2)
        order by full_name asc`,
      [consultation.group_name, consultation.created_by],
    );

    res.json({ consultation, members });
  }),
);

/**
 * POST /api/consultations/:id/complete
 * Body: { minutes?, tasks?: [{ description, assignee_id?, due_date? }] }
 *
 * The wrap-up, and the only thing in the system that creates an action item.
 * The adviser ran the session, so the adviser closes it: status becomes
 * 'completed' (which drops it out of every "upcoming" query) and the tasks
 * agreed in the room become rows the group can tick off.
 *
 * One transaction, because a half-written wrap-up -- session closed, tasks lost
 * -- cannot be recovered from the UI.
 */
app.post(
  '/api/consultations/:id/complete',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role !== 'adviser') {
      throw new HttpError(403, 'Only the adviser can complete a consultation.');
    }

    const consultation = await loadConsultationFor(req.profile, req.params.id);
    if (consultation.status !== 'scheduled') {
      throw new HttpError(
        409,
        consultation.status === 'completed'
          ? 'That session is already wrapped up.'
          : 'Only a scheduled session can be completed.',
      );
    }

    const minutes = String(req.body?.minutes ?? '').trim().slice(0, 5000) || null;
    const tasks = normalizeTasks(req.body?.tasks);

    const client = await pool.connect();
    try {
      await client.query('begin');

      const { rows } = await client.query(
        `update public.consultations
            set status = 'completed', completed_at = now(), minutes = $2
          where id = $1 and status = 'scheduled'
      returning id, topic, status, minutes, completed_at`,
        [consultation.id, minutes],
      );
      // Somebody else closed it between the check above and here.
      if (!rows[0]) throw new HttpError(409, 'That session is already wrapped up.');

      const created = [];
      for (const task of tasks) {
        const { rows: item } = await client.query(
          `insert into public.action_items
                  (consultation_id, task_description, assignee_id, due_date)
                values ($1, $2, $3, $4)
             returning id, task_description, assignee_id, status,
                       to_char(due_date, 'YYYY-MM-DD') as due_date`,
          [consultation.id, task.description, task.assigneeId, task.dueDate],
        );
        created.push(item[0]);
      }

      await client.query('commit');
      res.json({ consultation: rows[0], tasks: created });
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }),
);

/**
 * POST /api/consultations/:id/tasks
 * Body: { description, assignee_id?, due_date? }
 *
 * One more action item, after the fact. Wrapping up is the usual way they get
 * created, but something always comes up afterwards.
 */
app.post(
  '/api/consultations/:id/tasks',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role !== 'adviser') {
      throw new HttpError(403, 'Only the adviser can raise an action item.');
    }

    const consultation = await loadConsultationFor(req.profile, req.params.id);
    const [task] = normalizeTasks([
      {
        description: req.body?.description,
        assignee_id: req.body?.assignee_id,
        due_date: req.body?.due_date,
      },
    ]);
    if (!task) throw new HttpError(400, 'Describe the action item first.');

    const { rows } = await pool.query(
      `insert into public.action_items
              (consultation_id, task_description, assignee_id, due_date)
            values ($1, $2, $3, $4)
         returning id, task_description, assignee_id, status, created_at,
                   to_char(due_date, 'YYYY-MM-DD') as due_date`,
      [consultation.id, task.description, task.assigneeId, task.dueDate],
    );

    res.status(201).json({ task: rows[0] });
  }),
);

/**
 * Validates the action items coming out of a wrap-up form, dropping blank rows
 * so an untouched spare input does not become an empty task.
 */
function normalizeTasks(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((task) => {
      const description = String(task?.description ?? '').trim();
      if (!description) return null;
      if (description.length > 500) {
        throw new HttpError(400, 'An action item is too long (max 500 characters).');
      }

      const assigneeId = task?.assignee_id ? String(task.assignee_id) : null;
      if (assigneeId && !UUID_RE.test(assigneeId)) {
        throw new HttpError(400, 'That assignee is not valid.');
      }

      const dueDate = String(task?.due_date ?? '').trim() || null;
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        throw new HttpError(400, 'A due date must look like 2026-09-16.');
      }

      return { description, assigneeId, dueDate };
    })
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * PATCH /api/tasks/:id
 * Body: { status: 'pending' | 'resolved' } - backs the checkable task cards.
 */
app.patch(
  '/api/tasks/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const status = String(req.body?.status ?? '').trim();
    if (!['pending', 'resolved'].includes(status)) {
      throw new HttpError(400, 'Status must be pending or resolved.');
    }

    const { id, role, group_name: groupName } = req.profile;

    const { rows } = await pool.query(
      `update public.action_items a
          set status = $4,
              resolved_at = case when $4 = 'resolved' then now() else null end
         from public.consultations c
        where c.id = a.consultation_id
          and a.id = $5
          and (
                ($2 = 'adviser' and c.adviser_id = $1)
             or ($2 <> 'adviser' and (a.assignee_id = $1 or c.group_name = $3))
          )
    returning a.id, a.task_description, a.status`,
      [id, role, groupName, status, req.params.id],
    );

    if (!rows[0]) throw new HttpError(404, 'Task not found, or you cannot modify it.');
    res.json({ task: rows[0] });
  }),
);

/* ------------------------------------------------------------ plumbing --- */

/**
 * GET /api/health
 * Diagnostic: reports the real Postgres failure instead of the generic 500, so
 * a misconfigured DATABASE_URL can be identified from a browser. The password is
 * never included -- only host, port and the driver's error code.
 */
app.get('/api/health', async (_req, res) => {
  let target = { host: null, port: null, user: null };
  try {
    const url = new URL(DATABASE_URL);
    target = { host: url.hostname, port: url.port, user: decodeURIComponent(url.username) };
  } catch {
    return res.status(500).json({
      ok: false,
      stage: 'config',
      message: 'DATABASE_URL is not a valid connection string.',
    });
  }

  try {
    await pool.query('select 1');
    res.json({ ok: true, database: target, uptime: process.uptime() });
  } catch (err) {
    console.error('[health] database check failed:', err);
    res.status(500).json({
      ok: false,
      stage: 'database',
      code: err.code ?? null,
      message: err.message,
      database: target,
    });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
});

export { app, pool };
export default app;
