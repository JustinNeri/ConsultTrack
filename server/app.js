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
import { randomUUID } from 'node:crypto';
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
  // The opposite of AUTH_EMAIL_ALLOWLIST, and easy to confuse with it:
  //   AUTH_EMAIL_ALLOWLIST   WIDENS  - non-HAU addresses that may register
  //   SIGNUP_ALLOWLIST       NARROWS - the ONLY addresses we will email at all
  // Empty means open sign-up: any HAU address can ask for a code. Since
  // hau.edu.ph is a real domain with real staff behind it, set this on any
  // deployment that is not a private test, or a stranger poking at the demo can
  // make this server mail a live login code to an actual faculty member.
  SIGNUP_ALLOWLIST = '',
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
// Vercel and any other reverse proxy put the caller's address in
// X-Forwarded-For. Without this, req.ip is the proxy and the rate limiter
// treats every visitor as one client.
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(cors({ origin: CLIENT_ORIGIN.split(',').map((o) => o.trim()), credentials: true }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * A small fixed-window limiter, in memory.
 *
 * It exists to stop this server being turned into a mailer aimed at real HAU
 * staff: the code routes send an email to any address you name, and Supabase's
 * own throttle is per-address, so a script walking a list of addresses never
 * trips it.
 *
 * In memory is the right scope for what this defends. A serverless deployment
 * gives each container its own map, which weakens it but does not break it --
 * the alternative is a shared store this app does not otherwise need. Move it
 * to Postgres or Redis if you ever run this behind a real load balancer.
 */
const rateBuckets = new Map();

function rateLimit({ windowMs, max, key }) {
  return (req, _res, next) => {
    const bucket = `${key}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const seen = rateBuckets.get(bucket);

    if (!seen || now > seen.resetAt) {
      rateBuckets.set(bucket, { count: 1, resetAt: now + windowMs });
      // Opportunistic sweep, so the map cannot grow without bound.
      if (rateBuckets.size > 5000) {
        for (const [name, entry] of rateBuckets) {
          if (now > entry.resetAt) rateBuckets.delete(name);
        }
      }
      return next();
    }

    if (seen.count >= max) {
      const seconds = Math.ceil((seen.resetAt - now) / 1000);
      return next(new HttpError(429, `Too many attempts. Try again in ${seconds}s.`));
    }

    seen.count += 1;
    return next();
  };
}

// Sending a code puts mail in somebody's inbox, so it is the tightest.
const limitCodeSend = rateLimit({ windowMs: 10 * 60_000, max: 8, key: 'code-send' });
// Guessing a code or a password is cheap for the attacker and costly for us.
const limitCodeVerify = rateLimit({ windowMs: 10 * 60_000, max: 20, key: 'code-verify' });
const limitLogin = rateLimit({ windowMs: 10 * 60_000, max: 20, key: 'login' });

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

/*
 * Who this server is willing to send a login code to.
 *
 * An entry is either a whole address ("dean@hau.edu.ph") or a domain written
 * with its at-sign ("@student.hau.edu.ph"), which allows everyone on it. An
 * empty list disables the gate entirely and sign-up stays open, which is the
 * historical behaviour.
 */
const SIGNUP_GATE = SIGNUP_ALLOWLIST.split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

/**
 * Refuses to email an address the deployment has not opted in to.
 *
 * This is the only thing standing between a public demo and a real inbox: every
 * route that can cause mail to be sent calls it first.
 */
function assertMayReceiveCode(email) {
  if (!SIGNUP_GATE.length) return;

  const address = String(email).trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf('@'));
  const allowed = SIGNUP_GATE.some((entry) =>
    entry.startsWith('@') ? domain === entry : address === entry,
  );

  if (!allowed) {
    throw new HttpError(
      403,
      'Sign-up is limited to invited addresses on this deployment. Ask the administrator to add yours.',
    );
  }
}

// Loose on purpose - confirm HAU's real student-number format and tighten this.
const STUDENT_ID_RE = /^[0-9-]{6,20}$/;
// Faculty numbers vary more than student ones, so letters are allowed too.
const EMPLOYEE_ID_RE = /^[A-Za-z0-9-]{4,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A class section: "CS-401", "IT401A", "BSIT 4-B". Letters, digits, spaces and
// dashes, which is every form the registrar actually prints.
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,19}$/;
// Join codes avoid 0/O and 1/I, because these get read aloud and written down.
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* --------------------------------------------------------- auth middleware */

/**
 * The predicate deciding whether a student may see a consultation row.
 *
 * Two ways in, and which applies depends on the row:
 *
 *   a consultation with a real group is reachable only by its members. Not by
 *   whoever booked it -- a student who leaves a group should stop seeing its
 *   sessions, including the ones they booked themselves;
 *
 *   a consultation from before groups existed has no membership to check, so it
 *   falls back to the person who booked it or to the old group_name string.
 *
 * Takes placeholders rather than values, so each caller keeps its own numbering.
 */
/**
 * The adviser side of the same question.
 *
 * The lead adviser owns the session, but a panelist has to see the defense they
 * are sitting on -- including its thread, its files and its record.
 */
function adviserVisibility(adviser) {
  return `(
              c.adviser_id = ${adviser}
           or exists (
                select 1 from public.consultation_panelists cp
                 where cp.consultation_id = c.id and cp.adviser_id = ${adviser}
              )
         )`;
}

function groupVisibility({ creator, groupId, groupName }) {
  return `(
              (c.group_id is not null
                and ${groupId}::uuid is not null
                and c.group_id = ${groupId})
           or (c.group_id is null
                and (
                     c.created_by = ${creator}
                  or (c.group_name is not null and c.group_name = ${groupName})
                ))
         )`;
}

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

    /*
     * Which thesis group they belong to, if any.
     *
     * Read separately rather than joined into the select above, because that
     * column list is reused in RETURNING clauses where a join is not available.
     *
     * The group's own name wins over `profiles.group_name`: the profile column
     * is a leftover from when a group was whatever string you typed, and it can
     * disagree with the group you are actually a member of.
     */
    const { rows: membership } = await pool.query(
      `select g.id, g.name, g.section, g.join_code, m.role
         from public.thesis_group_members m
         join public.thesis_groups g on g.id = m.group_id
        where m.profile_id = $1
        limit 1`,
      [data.user.id],
    );

    req.user = data.user;
    // Storage is reached as the caller, not as the service, so their token has
    // to outlive the check that validated it.
    req.accessToken = token;
    req.profile = rows[0] ?? {
      id: data.user.id,
      full_name: null,
      email: data.user.email,
      role: 'student',
      group_name: null,
      section: null,
      is_coordinator: false,
      adviser_capacity: null,
    };

    const group = membership[0] ?? null;
    req.profile.group_id = group?.id ?? null;
    req.profile.group_role = group?.role ?? null;
    if (group) {
      req.profile.group_name = group.name;
      req.profile.group_section = group.section;
      req.profile.group_join_code = group.join_code;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Coordinators.
 *
 * A capstone coordinator is a faculty member who also runs the program, so it is
 * a capability on top of the adviser role rather than a role of its own -- every
 * `role = 'adviser'` check in this file stays true for them, and they keep
 * advising their own groups.
 *
 * Their reach is their department. There is no university-wide view, because
 * there is nobody whose job that is.
 */
function requireCoordinator(req, _res, next) {
  if (!req.profile?.is_coordinator) {
    return next(new HttpError(403, 'That is a capstone coordinator view.'));
  }
  if (!req.profile.department) {
    return next(new HttpError(409, 'Your profile has no department, so there is nothing to coordinate.'));
  }
  return next();
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

const PROFILE_COLUMNS = `id, full_name, email, role, group_name, section,
                         is_coordinator, adviser_capacity,
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
  limitCodeSend,
  asyncRoute(async (req, res) => {
    const email = requireHauEmail(req.body?.email);
    assertMayReceiveCode(email);

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
 *
 * Strictly a *resend*. It used to mail any well-formed HAU address on request,
 * creating the account on the way, which made it an open relay pointed at a real
 * university's domain: anyone could have this server send a live login code to
 * a real member of staff. There must now already be a half-finished sign-up to
 * resend for, and `createUser: false` means it can no longer conscript an
 * address that has no account.
 */
app.post(
  '/api/auth/send-code',
  limitCodeSend,
  asyncRoute(async (req, res) => {
    const email = requireHauEmail(req.body?.email);
    assertMayReceiveCode(email);

    const { rows } = await pool.query(
      `select registration_completed_at from public.profiles where email = $1`,
      [email],
    );
    if (!rows.length) {
      throw new HttpError(404, 'Start the sign-up first, then we can resend your code.');
    }
    if (rows[0].registration_completed_at) {
      throw new HttpError(409, 'That email is already registered. Sign in instead.');
    }

    await sendAccessCode(email, { createUser: false });
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
  limitCodeVerify,
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
    // The class section, e.g. CS-401. Required of students: it is what makes a
    // group name unique, since every section has a "Group 1".
    const section = isAdviser ? '' : String(req.body?.section ?? '').trim().toUpperCase();

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
      if (!section) throw new HttpError(400, 'Section is required.');
      if (!SECTION_RE.test(section)) {
        throw new HttpError(400, 'Enter a valid section, e.g. CS-401.');
      }
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
          : { student_id: studentId, course, year_level: yearLevel, section }),
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
              role = $12, section = $13,
              email_verified_at = coalesce(email_verified_at, now()),
              registration_completed_at = now()
        where id = $1
    returning ${PROFILE_COLUMNS}`,
      [req.profile.id, fullName, lastName, firstName, middleInitial || null,
       studentId || null, department, course || null, yearLevel || null,
       employeeId || null, facultyPosition || null, role, section || null],
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
  limitLogin,
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

/**
 * PATCH /api/me
 * Body: any of { lastName, firstName, middleInitial, section, course, yearLevel,
 *                facultyPosition }
 *
 * Everything on a profile that a person can legitimately correct themselves.
 *
 * Deliberately not editable here: email (it is the identity the login code was
 * sent to), role (it is derived from the email domain), student and faculty ID
 * (they are the registrar's, and letting someone retype one would let them
 * claim another person's number), and department (it scopes which advisers and
 * groups you can reach).
 *
 * Only fields actually present in the body are touched, so a form that sends
 * one field cannot blank the rest.
 */
app.patch(
  '/api/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const isAdviser = req.profile.role === 'adviser';
    const updates = {};

    const text = (key, max = 120) =>
      typeof req.body?.[key] === 'string' ? req.body[key].trim().slice(0, max) : undefined;

    const lastName = text('lastName');
    const firstName = text('firstName');
    const middleInitial = text('middleInitial', 1);

    if (lastName !== undefined) {
      if (!lastName) throw new HttpError(400, 'Last name cannot be empty.');
      updates.last_name = lastName;
    }
    if (firstName !== undefined) {
      if (!firstName) throw new HttpError(400, 'First name cannot be empty.');
      updates.first_name = firstName;
    }
    if (middleInitial !== undefined) updates.middle_initial = middleInitial || null;

    if (!isAdviser) {
      const section = text('section', 20);
      if (section !== undefined) {
        if (!section) throw new HttpError(400, 'Section cannot be empty.');
        const upper = section.toUpperCase();
        if (!SECTION_RE.test(upper)) {
          throw new HttpError(400, 'Enter a valid section, e.g. CS-401.');
        }
        updates.section = upper;
      }

      // Registration does not validate the course against a list either -- the
      // course/department pairing lives in the client's hau.js -- so this
      // accepts what the form sends rather than inventing a stricter rule.
      const course = text('course');
      if (course !== undefined) {
        if (!course) throw new HttpError(400, 'Course cannot be empty.');
        updates.course = course;
      }

      const yearLevel = text('yearLevel', 40);
      if (yearLevel !== undefined) {
        if (yearLevel && !YEAR_LEVELS.includes(yearLevel)) {
          throw new HttpError(400, 'Select a valid year level.');
        }
        updates.year_level = yearLevel || null;
      }
    } else {
      const facultyPosition = text('facultyPosition', 60);
      if (facultyPosition !== undefined) {
        if (facultyPosition && !FACULTY_POSITIONS.includes(facultyPosition)) {
          throw new HttpError(400, 'Select a valid academic position.');
        }
        updates.faculty_position = facultyPosition || null;
      }
    }

    if (!Object.keys(updates).length) {
      throw new HttpError(400, 'Nothing to update.');
    }

    // A name change has to reach full_name too, which is what everything else
    // in the app actually displays.
    if (updates.last_name || updates.first_name || 'middle_initial' in updates) {
      updates.full_name = composeFullName({
        lastName: updates.last_name ?? req.profile.last_name ?? '',
        firstName: updates.first_name ?? req.profile.first_name ?? '',
        middleInitial:
          'middle_initial' in updates
            ? (updates.middle_initial ?? '')
            : (req.profile.middle_initial ?? ''),
      });
    }

    const columns = Object.keys(updates);
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');

    const { rows } = await pool.query(
      `update public.profiles set ${assignments} where id = $1 returning ${PROFILE_COLUMNS}`,
      [req.profile.id, ...columns.map((column) => updates[column])],
    );

    // group_name on the profile mirrors the group, not the person, so a rename
    // of the person does not touch it.
    res.json({ profile: { ...rows[0], group_id: req.profile.group_id ?? null } });
  }),
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
  const { id, role, group_name: groupName, group_id: groupId } = profile;

  const { rows } = await pool.query(
    `select c.id,
            c.group_name,
            c.topic,
            c.location,
            c.meeting_date,
            c.status,
            c.proposed_date,
            c.proposed_by,
            c.proposed_note,
            (c.proposed_date is not null and c.proposed_date > now()) as proposal_live,
            pb.full_name as proposed_by_name,
            p.full_name as adviser_name,
            p.email     as adviser_email
       from public.consultations c
       left join public.profiles p on p.id = c.adviser_id
       left join public.profiles pb on pb.id = c.proposed_by
      where c.status = 'scheduled'
        and c.meeting_date >= now()
        and (
              ($2 = 'adviser' and ${adviserVisibility('$1')})
           or ($2 <> 'adviser' and ${groupVisibility({ creator: '$1', groupId: '$5', groupName: '$3' })})
        )
      order by c.meeting_date asc
      limit $4`,
    [id, role, groupName, limit, groupId],
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
    const { id, role, group_name: groupName, group_id: groupId } = req.profile;

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
              c.proposed_date,
              c.proposed_by,
              c.proposed_note,
              c.cancel_reason,
              c.cancelled_by,
              s.full_name  as requester_name,
              s.email      as requester_email,
              s.course     as requester_course,
              s.year_level as requester_year_level,
              p.full_name  as adviser_name,
              p.email      as adviser_email,
              pb.full_name as proposed_by_name,
              (c.proposed_date is not null and c.proposed_date > now()) as proposal_live,
              -- Whose move it is. An adviser who has already counter-offered is
              -- waiting on the student, so the request leaves their queue.
              case
                when c.proposed_date is not null and c.proposed_date > now()
                     and c.proposed_by <> $1 then true
                when $2 = 'adviser' and c.status = 'pending'
                     and (c.proposed_date is null or c.proposed_date <= now()) then true
                else false
              end as needs_you
         from public.consultations c
         left join public.profiles s on s.id = c.created_by
         left join public.profiles p on p.id = c.adviser_id
         left join public.profiles pb on pb.id = c.proposed_by
        where (
                ($2 = 'adviser' and c.adviser_id = $1 and (
                      c.status = 'pending'
                   or (c.status = 'scheduled' and c.proposed_date is not null
                       and c.proposed_date > now() and c.proposed_by <> $1)
                ))
             or ($2 <> 'adviser'
                 and ${groupVisibility({ creator: '$1', groupId: '$4', groupName: '$3' })}
                 and (
                       c.status = 'pending'
                       -- A move proposed on a booked session needs an answer
                       -- too, so it belongs in the same queue.
                    or (c.status = 'scheduled' and c.proposed_date is not null
                        and c.proposed_date > now() and c.proposed_by <> $1)
                    or (c.status in ('declined', 'cancelled')
                        and coalesce(c.responded_at, c.cancelled_at)
                            > now() - interval '14 days')
                 ))
              )
        order by c.meeting_date asc`,
      [id, role, groupName, groupId],
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
                     and (
                           (c.meeting_date >= b.slot_start
                            and c.meeting_date < b.slot_start
                                                 + make_interval(mins => b.slot_minutes))
                           -- A time the adviser has offered somebody else is
                           -- spoken for until they answer, or it lapses.
                        or (c.proposed_date is not null
                            and c.proposed_date > now()
                            and c.proposed_date >= b.slot_start
                            and c.proposed_date < b.slot_start
                                                  + make_interval(mins => b.slot_minutes))
                     )
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
async function slotStatus(adviserId, meetingDate, { excludeId = null } = {}) {
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
                -- Rescheduling a session must not collide with itself.
                and ($5::uuid is null or c.id <> $5)
                and (
                      (c.meeting_date > r.at
                         - make_interval(mins => coalesce((select slot_minutes from match), $4))
                       and c.meeting_date < r.at
                         + make_interval(mins => coalesce((select slot_minutes from match), $4)))
                   or (c.proposed_date is not null
                       and c.proposed_date > now()
                       and c.proposed_date > r.at
                         - make_interval(mins => coalesce((select slot_minutes from match), $4))
                       and c.proposed_date < r.at
                         + make_interval(mins => coalesce((select slot_minutes from match), $4)))
                )
            )                                                     as clashes`,
    [adviserId, meetingDate.toISOString(), CAMPUS_TIMEZONE, DEFAULT_SLOT_MINUTES, excludeId],
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
    const { id, role, group_name: groupName, group_id: groupId } = req.profile;

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
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and (a.assignee_id = $1 or ${groupVisibility({ creator: '$1', groupId: '$4', groupName: '$3' })}))
          )
        order by c.meeting_date asc nulls last, a.created_at asc`,
      [id, role, groupName, groupId],
    );

    res.json({ tasks: rows });
  }),
);

/**
 * POST /api/consultations
 * Body: { topic, meeting_date (ISO), location?, group_id?, group_name?, adviser_id? }
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
    if (!topic) throw new HttpError(400, 'A meeting agenda / topic is required.');
    if (topic.length > 500) throw new HttpError(400, 'The topic is too long (max 500 characters).');

    /*
     * Which group the session belongs to.
     *
     * A student books for the group they are a member of, and cannot name
     * another -- that is the whole point of memberships. An adviser names one
     * of the groups they already advise, and may still fall back to a free-text
     * name for a group that has not registered itself yet.
     */
    let groupId = null;
    let groupName = '';

    if (req.profile.role === 'adviser') {
      const requestedId = String(req.body?.group_id ?? '').trim();
      if (requestedId) {
        if (!UUID_RE.test(requestedId)) throw new HttpError(400, 'That group is not valid.');
        // Same set the picker offers: their department, or a group they already
        // advise. Anything else is somebody else's school.
        const { rows: bookable } = await pool.query(
          `select g.id, g.name
             from public.thesis_groups g
            where g.id = $1
              and (
                    ($3::text is null or g.department is null or g.department = $3)
                 or exists (
                      select 1 from public.consultations c
                       where c.group_id = g.id and c.adviser_id = $2
                    )
              )
            limit 1`,
          [requestedId, req.profile.id, req.profile.department ?? null],
        );
        if (!bookable.length) throw new HttpError(403, 'That group is not in your department.');
        groupId = bookable[0].id;
        groupName = bookable[0].name;
      } else {
        groupName = String(req.body?.group_name ?? '').trim();
        if (!groupName) throw new HttpError(400, 'Name the group this session is with.');
      }
    } else {
      if (!req.profile.group_id) {
        throw new HttpError(
          409,
          'Create or join a thesis group before booking - a consultation belongs to the whole group.',
        );
      }
      groupId = req.profile.group_id;
      groupName = req.profile.group_name;

      /*
       * If a coordinator has assigned this group an adviser, that is who they
       * book with. Assignment that a student could route around would not be
       * assignment, and the adviser's capacity is counted on it.
       */
      const { rows: assigned } = await pool.query(
        `select adviser_id from public.thesis_groups where id = $1 limit 1`,
        [groupId],
      );
      const assignedAdviser = assigned[0]?.adviser_id ?? null;
      if (assignedAdviser && req.body?.adviser_id && req.body.adviser_id !== assignedAdviser) {
        throw new HttpError(403, 'Your group has an assigned adviser. Book with them.');
      }
      if (assignedAdviser) req.body.adviser_id = assignedAdviser;
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
              (adviser_id, group_name, group_id, topic, location, meeting_date, status, created_by)
       values ($1, $2, $8, $3, $4, $5, $7, $6)
    returning id, adviser_id, group_name, group_id, topic, location, meeting_date, status, created_at`,
      // A slot carries the room its block named, so a student who left the
      // location blank still gets "Faculty Room 204" on the booking.
      [adviserId, groupName, topic, location ?? slot.slotLocation, meetingDate.toISOString(),
       req.profile.id, status, groupId],
    );

    res.status(201).json({ consultation: rows[0] });
  }),
);

/* --------------------------------------------- counter-offers and moves -- */

/*
 * A student asks for 9-11am; the adviser teaches then and wants 12pm.
 *
 * The adviser offers the alternative and the student still has to accept it,
 * because the student asked for 9am precisely because that is when they are
 * free -- 12pm is very likely a class, and booking it for them produces a
 * no-show rather than a meeting. It is not a negotiation either: one
 * counter-offer, then accept or start over.
 *
 * `meeting_date` keeps holding the *agreed* time throughout. Only accepting
 * moves it, so a proposal can never quietly relocate a session nobody agreed to
 * move. `proposed_date` is live only while it is in the future, so a proposal
 * nobody answered expires on its own and stops holding its slot.
 */

/** Who has to act next on a consultation, or null when nobody does. */
function turnOf(consultation) {
  const live =
    consultation.proposed_date && new Date(consultation.proposed_date).getTime() > Date.now();

  if (live) return { waitingOn: 'other', proposedBy: consultation.proposed_by };
  if (consultation.status === 'pending') return { waitingOn: 'adviser', proposedBy: null };
  return null;
}

/**
 * POST /api/consultations/:id/propose
 * Body: { meeting_date (ISO), note? }
 *
 * On a pending request this is the adviser's counter-offer. On a scheduled
 * session it is a request to move it, which either side may raise -- and which
 * the other side has to accept before anything actually moves.
 */
app.post(
  '/api/consultations/:id/propose',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    if (!['pending', 'scheduled'].includes(consultation.status)) {
      throw new HttpError(409, 'That consultation is closed.');
    }
    // A pending request is the adviser's to answer; the student already made
    // their offer by booking it.
    if (consultation.status === 'pending' && req.profile.role !== 'adviser') {
      throw new HttpError(
        403,
        'Your adviser answers this request. To ask for another time, cancel it and book a different slot.',
      );
    }

    const turn = turnOf(consultation);
    if (turn?.waitingOn === 'other' && turn.proposedBy !== req.profile.id) {
      throw new HttpError(409, 'There is already a time waiting on your answer.');
    }

    const rawDate = String(req.body?.meeting_date ?? '').trim();
    const proposed = new Date(rawDate);
    if (!rawDate || Number.isNaN(proposed.getTime())) {
      throw new HttpError(400, 'Pick a valid date and time.');
    }
    if (proposed.getTime() <= Date.now()) {
      throw new HttpError(400, 'Propose a time in the future.');
    }
    if (proposed.getTime() === new Date(consultation.meeting_date).getTime()) {
      throw new HttpError(400, 'That is already the time on this consultation.');
    }

    const note = String(req.body?.note ?? '').trim().slice(0, 500) || null;

    // The adviser proposes out of their own diary, so the published-hours rule
    // does not apply to them -- but a double-booking still does.
    const slot = await slotStatus(consultation.adviser_id, proposed, {
      excludeId: consultation.id,
    });
    if (slot.taken) {
      throw new HttpError(409, 'There is already something at that time.');
    }

    const { rows } = await pool.query(
      `update public.consultations
          set proposed_date = $2, proposed_by = $3, proposed_at = now(), proposed_note = $4
        where id = $1 and status in ('pending', 'scheduled')
    returning id, status, meeting_date, proposed_date, proposed_by, proposed_note`,
      [consultation.id, proposed.toISOString(), req.profile.id, note],
    );

    if (!rows[0]) throw new HttpError(409, 'That consultation is closed.');
    res.json({ consultation: rows[0] });
  }),
);

/**
 * PATCH /api/consultations/:id/proposal
 * Body: { decision: 'accepted' | 'declined', reason? }
 *
 * The other side's answer, and the only thing that actually moves a session.
 * Declining a counter-offer on a *request* ends it -- there is no ping-pong, and
 * the group books again from the adviser's open slots. Declining a move on an
 * already-scheduled session just leaves the original time standing.
 */
app.patch(
  '/api/consultations/:id/proposal',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    const decision = String(req.body?.decision ?? '').trim();
    if (!['accepted', 'declined'].includes(decision)) {
      throw new HttpError(400, 'Decision must be accepted or declined.');
    }

    const turn = turnOf(consultation);
    if (turn?.waitingOn !== 'other') {
      throw new HttpError(409, 'There is no live proposal on that consultation.');
    }
    // Answering your own offer would let one side write into the other's diary.
    if (turn.proposedBy === req.profile.id) {
      throw new HttpError(403, 'You proposed that time. The other side answers it.');
    }

    const reason = String(req.body?.reason ?? '').trim().slice(0, 500) || null;

    let sql;
    let params;
    if (decision === 'accepted') {
      sql = `update public.consultations
                set meeting_date = proposed_date,
                    status = 'scheduled',
                    responded_at = now(),
                    proposed_date = null, proposed_by = null,
                    proposed_at = null, proposed_note = null
              where id = $1 and proposed_date is not null and proposed_date > now()
          returning id, status, meeting_date, topic, group_name, location`;
      params = [consultation.id];
    } else if (consultation.status === 'pending') {
      // The counter-offer was the answer to the request, so refusing it ends
      // the request rather than reopening it.
      sql = `update public.consultations
                set status = 'cancelled',
                    cancelled_at = now(), cancelled_by = $2, cancel_reason = $3,
                    proposed_date = null, proposed_by = null,
                    proposed_at = null, proposed_note = null
              where id = $1 and proposed_date is not null and proposed_date > now()
          returning id, status, meeting_date, topic, group_name, location`;
      params = [consultation.id, req.profile.id, reason ?? 'The proposed time did not work.'];
    } else {
      // A refused move on a booked session: the original time stands.
      sql = `update public.consultations
                set proposed_date = null, proposed_by = null,
                    proposed_at = null, proposed_note = null
              where id = $1 and proposed_date is not null and proposed_date > now()
          returning id, status, meeting_date, topic, group_name, location`;
      params = [consultation.id];
    }

    const { rows } = await pool.query(sql, params);
    if (!rows[0]) throw new HttpError(409, 'That proposal is no longer open.');

    res.json({ consultation: rows[0], decision });
  }),
);

/**
 * PATCH /api/consultations/:id/cancel
 * Body: { reason }
 *
 * Either side calling it off, and the first thing in this system that can reach
 * the 'cancelled' status -- it has sat in the CHECK constraint since 0005 with
 * nothing able to set it. A student withdrawing a request and an adviser who
 * cannot make a booked session are the same operation.
 */
app.patch(
  '/api/consultations/:id/cancel',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    if (!['pending', 'scheduled'].includes(consultation.status)) {
      throw new HttpError(409, 'That consultation is already closed.');
    }

    const reason = String(req.body?.reason ?? '').trim().slice(0, 500);
    if (!reason) throw new HttpError(400, 'Give the other side a reason.');

    const { rows } = await pool.query(
      `update public.consultations
          set status = 'cancelled',
              cancelled_at = now(), cancelled_by = $2, cancel_reason = $3,
              proposed_date = null, proposed_by = null,
              proposed_at = null, proposed_note = null
        where id = $1 and status in ('pending', 'scheduled')
    returning id, status, topic, group_name, meeting_date, cancel_reason`,
      [consultation.id, req.profile.id, reason],
    );

    if (!rows[0]) throw new HttpError(409, 'That consultation is already closed.');
    res.json({ consultation: rows[0] });
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
    `select c.id, c.adviser_id, c.group_name, c.group_id, c.topic, c.location, c.meeting_date,
            c.status, c.created_by, c.created_at, c.decline_reason,
            c.minutes, c.completed_at,
            c.proposed_date, c.proposed_by, c.proposed_note,
            c.cancel_reason, c.cancelled_by,
            p.full_name as adviser_name,
            p.email     as adviser_email,
            s.full_name as requester_name,
            s.email     as requester_email
       from public.consultations c
       left join public.profiles p on p.id = c.adviser_id
       left join public.profiles s on s.id = c.created_by
      where c.id = $1
        and (
              ($3 = 'adviser' and ${adviserVisibility('$2')})
           or ($3 <> 'adviser' and ${groupVisibility({ creator: '$2', groupId: '$5', groupName: '$4' })})
        )
      limit 1`,
    [consultationId, profile.id, profile.role, profile.group_name, profile.group_id],
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
    const { id, role, group_name: groupName, group_id: groupId } = req.profile;

    const { rows } = await pool.query(
      `select c.id as consultation_id, c.topic, count(m.id)::int as unread
         from public.consultations c
         join public.consultation_messages m on m.consultation_id = c.id
         left join public.consultation_reads r
                on r.consultation_id = c.id and r.profile_id = $1
        where (
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and ${groupVisibility({ creator: '$1', groupId: '$4', groupName: '$3' })})
              )
          and m.sender_id <> $1
          and (r.last_read_at is null or m.created_at > r.last_read_at)
        group by c.id, c.topic
        order by count(m.id) desc`,
      [id, role, groupName, groupId],
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

    const { id, role, group_name: groupName, group_id: groupId } = req.profile;

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
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and ${groupVisibility({ creator: '$1', groupId: '$5', groupName: '$3' })})
          )
        order by c.meeting_date desc
        limit $4`,
      [id, role, groupName, limit, groupId],
    );

    res.json({ consultations: rows });
  }),
);

/* ------------------------------------------------ the consultation record - */

/*
 * The record is the paper logbook a group brings to their defense: every
 * session they held, what was agreed, who was there and what it left them to
 * do. Everything it prints was already in the database -- until now nothing
 * could get it out of the screen.
 *
 * There is no "record signed" flag. A completed consultation is already the
 * adviser's attestation: they wrote the minutes and marked it done, so each
 * session cites its own `completed_at` and the sheet leaves a signature line
 * for the wet signature these forms get anyway.
 */

/**
 * GET /api/groups
 *
 * The groups the caller can pull a record for: for an adviser, every group they
 * have advised; for a student, their own. Ordered by most recent session, which
 * is the one an adviser is most likely to want.
 */
app.get(
  '/api/groups',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { id, role, group_name: groupName, group_id: groupId } = req.profile;

    const { rows } = await pool.query(
      `select g.id                                                       as group_id,
              coalesce(g.name, min(c.group_name))                        as group_name,
              g.section                                                  as section,
              count(*)::int                                              as total,
              count(*) filter (where c.status = 'completed')::int        as completed,
              max(c.meeting_date)                                        as last_session
         from public.consultations c
         left join public.thesis_groups g on g.id = c.group_id
        where c.group_name is not null
          and (
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and ${groupVisibility({ creator: '$1', groupId: '$4', groupName: '$3' })})
          )
        -- Rows with a real group collapse on its id, so a rename keeps one
        -- record rather than splitting it. Rows without one still collapse on
        -- the name, which is all they have.
        group by g.id, g.name, g.section,
                 (case when c.group_id is null then c.group_name end)
        order by max(c.meeting_date) desc`,
      [id, role, groupName, groupId],
    );

    res.json({ groups: rows });
  }),
);

/**
 * GET /api/record?group_id=<uuid>   (a registered group)
 * GET /api/record?group=Group%207    (a group that predates them)
 *
 * Every session that group has already held, in order, with its minutes,
 * attendance and action items. Access is the same predicate as everywhere else,
 * so an adviser gets the sessions they advised and a student their own group's;
 * a group the caller has no claim on simply comes back empty and 404s.
 */
app.get(
  '/api/record',
  requireAuth,
  asyncRoute(async (req, res) => {
    /*
     * Prefer the id. Two sections can both have a "Group 1", so a name alone
     * would pull both into one document -- and this document is the log a group
     * hands in at their defense.
     */
    const recordGroupId = String(req.query.group_id ?? '').trim();
    const group = String(req.query.group ?? '').trim();
    if (recordGroupId && !UUID_RE.test(recordGroupId)) {
      throw new HttpError(400, 'That group is not valid.');
    }
    if (!recordGroupId && !group) {
      throw new HttpError(400, 'Name the group whose record you want.');
    }

    const { id, role, group_name: groupName, group_id: groupId } = req.profile;

    const { rows } = await pool.query(
      `select c.id, c.group_id, c.topic, c.location, c.meeting_date, c.status,
              c.minutes, c.completed_at,
              p.full_name       as adviser_name,
              p.faculty_position as adviser_position,
              p.email           as adviser_email,
              coalesce((
                select json_agg(json_build_object(
                         'name', pp.full_name,
                         'position', pp.faculty_position,
                         'role', cp.role
                       ) order by (cp.role = 'chair') desc, pp.full_name)
                  from public.consultation_panelists cp
                  join public.profiles pp on pp.id = cp.adviser_id
                 where cp.consultation_id = c.id
              ), '[]'::json) as panel,
              coalesce((
                select json_agg(json_build_object(
                         'name', pr.full_name,
                         'student_id', pr.student_id,
                         'present', at.present
                       ) order by pr.full_name)
                  from public.consultation_attendance at
                  join public.profiles pr on pr.id = at.profile_id
                 where at.consultation_id = c.id
              ), '[]'::json) as attendance,
              coalesce((
                select json_agg(json_build_object(
                         'description', a.task_description,
                         'status', a.status,
                         'assignee', asg.full_name,
                         'due_date', to_char(a.due_date, 'YYYY-MM-DD')
                       ) order by a.created_at)
                  from public.action_items a
                  left join public.profiles asg on asg.id = a.assignee_id
                 where a.consultation_id = c.id
              ), '[]'::json) as action_items
         from public.consultations c
         left join public.profiles p on p.id = c.adviser_id
        where (
                ($6::uuid is not null and c.group_id = $6)
             or ($6::uuid is null and c.group_id is null and c.group_name = $4)
              )
          and c.status in ('scheduled', 'completed')
          and (c.completed_at is not null or c.meeting_date < now())
          and (
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and ${groupVisibility({ creator: '$1', groupId: '$5', groupName: '$3' })})
          )
        order by c.meeting_date asc`,
      [id, role, groupName, group || null, groupId, recordGroupId || null],
    );

    if (!rows.length) {
      throw new HttpError(404, 'No sessions on record for that group yet.');
    }

    // The heading needs the group's own details, which live on the students
    // rather than on the consultation.
    // A registered group has a roster; one that predates groups has only the
    // students who happened to carry the same name on their profile.
    const headingGroupId = recordGroupId || rows[0]?.group_id || null;

    const { rows: members } = await pool.query(
      `select p.full_name, p.student_id, p.course, p.year_level, p.section
         from public.profiles p
         join public.thesis_group_members m on m.profile_id = p.id
        where m.group_id = $1
        union
       select p.full_name, p.student_id, p.course, p.year_level, p.section
         from public.profiles p
        where $1::uuid is null and p.role = 'student' and p.group_name = $2
        order by full_name asc`,
      [headingGroupId, group || null],
    );

    let heading = group;
    let section = null;
    if (headingGroupId) {
      const { rows: named } = await pool.query(
        `select name, section from public.thesis_groups where id = $1 limit 1`,
        [headingGroupId],
      );
      heading = named[0]?.name ?? group;
      section = named[0]?.section ?? null;
    }

    res.json({
      group: heading,
      group_id: headingGroupId,
      section,
      members,
      sessions: rows,
      generated_at: new Date().toISOString(),
    });
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

    /*
     * Who to offer for attendance: the group's roster, plus whoever booked the
     * session in case they are not on it. The `group_id is null` branch keeps
     * consultations that predate groups working off the old name match.
     */
    const { rows: members } = await pool.query(
      `select distinct p.id, p.full_name, p.email
         from public.profiles p
        where p.role = 'student'
          and (
                exists (
                  select 1 from public.thesis_group_members m
                   where m.profile_id = p.id and m.group_id = $1
                )
             or ($1::uuid is null and $2::text is not null and p.group_name = $2)
             or p.id = $3
          )
        order by p.full_name asc`,
      [consultation.group_id ?? null, consultation.group_name, consultation.created_by],
    );

    res.json({ consultation, members });
  }),
);

/* --------------------------------------------------------- thesis groups -- */

/**
 * A join code somebody has to read out loud.
 *
 * Six characters from an alphabet with no 0/O or 1/I, so a code copied off a
 * whiteboard resolves to exactly one group. Collisions are retried rather than
 * prevented: the space is 32^6, and the unique index is the real guarantee.
 */
function makeJoinCode() {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/** The group plus its roster, shaped the way every group screen wants it. */
async function loadGroup(groupId) {
  const { rows: groups } = await pool.query(
    `select g.id, g.name, g.section, g.department, g.join_code, g.created_at,
            g.created_by
       from public.thesis_groups g
      where g.id = $1
      limit 1`,
    [groupId],
  );
  if (!groups.length) return null;

  const { rows: members } = await pool.query(
    `select p.id, p.full_name, p.email, p.student_id, p.course, p.year_level,
            p.section, m.role, m.joined_at
       from public.thesis_group_members m
       join public.profiles p on p.id = m.profile_id
      where m.group_id = $1
      order by (m.role = 'leader') desc, p.full_name asc`,
    [groupId],
  );

  return { ...groups[0], members };
}

/**
 * GET /api/thesis-groups/mine
 *
 * The caller's own group, or null. An adviser has none; they see groups through
 * the consultations they advise.
 */
app.get(
  '/api/thesis-groups/mine',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.profile.group_id) return res.json({ group: null });
    res.json({ group: await loadGroup(req.profile.group_id) });
  }),
);

/**
 * POST /api/thesis-groups
 * Body: { name }
 *
 * Creates a group and makes the caller its leader, in one transaction -- a
 * group with no members would be unreachable, since membership is the only way
 * back to it.
 *
 * The section comes from the profile rather than the request: it is what makes
 * the name unique, and letting a student name someone else's section would let
 * them collide with a group they cannot see.
 */
app.post(
  '/api/thesis-groups',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role === 'adviser') {
      throw new HttpError(403, 'Advisers do not belong to a thesis group.');
    }
    if (req.profile.group_id) {
      throw new HttpError(409, 'You are already in a thesis group. Leave it first.');
    }

    const section = String(req.profile.section ?? '').trim().toUpperCase();
    if (!section) {
      throw new HttpError(
        400,
        'Add your section to your profile before creating a group.',
      );
    }

    const name = String(req.body?.name ?? '').trim();
    if (name.length < 2 || name.length > 120) {
      throw new HttpError(400, 'Give the group a name of 2 to 120 characters.');
    }

    const client = await pool.connect();
    try {
      await client.query('begin');

      let group = null;
      // Retry only the code collision; a duplicate name is the caller's problem
      // and has to surface as a 409.
      for (let attempt = 0; attempt < 5 && !group; attempt += 1) {
        try {
          const { rows } = await client.query(
            `insert into public.thesis_groups (name, section, department, join_code, created_by)
                  values ($1, $2, $3, $4, $5)
               returning id, name, section, department, join_code, created_at, created_by`,
            [name, section, req.profile.department ?? null, makeJoinCode(), req.profile.id],
          );
          group = rows[0];
        } catch (err) {
          if (err.code !== '23505') throw err;
          if (String(err.constraint ?? '').includes('join_code')) continue;
          throw new HttpError(409, `Section ${section} already has a group called "${name}".`);
        }
      }
      if (!group) throw new HttpError(503, 'Could not allocate a join code. Try again.');

      await client.query(
        `insert into public.thesis_group_members (group_id, profile_id, role)
              values ($1, $2, 'leader')`,
        [group.id, req.profile.id],
      );

      // Kept in step so the leftover profile column and the group agree; a few
      // legacy queries still read it.
      await client.query(`update public.profiles set group_name = $2 where id = $1`, [
        req.profile.id,
        group.name,
      ]);

      await client.query('commit');
      res.status(201).json({ group: await loadGroup(group.id) });
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

/**
 * POST /api/thesis-groups/join
 * Body: { code }
 *
 * The code is the whole authorisation. There is deliberately no way to list
 * groups you are not in, so a code is the only route to one you did not create.
 */
app.post(
  '/api/thesis-groups/join',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role === 'adviser') {
      throw new HttpError(403, 'Advisers do not belong to a thesis group.');
    }
    if (req.profile.group_id) {
      throw new HttpError(409, 'You are already in a thesis group. Leave it first.');
    }

    const code = String(req.body?.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      throw new HttpError(400, 'A join code is six letters and digits.');
    }

    const { rows } = await pool.query(
      `select id, name, section from public.thesis_groups where join_code = $1 limit 1`,
      [code],
    );
    const group = rows[0];
    if (!group) throw new HttpError(404, 'No group has that code.');

    // A group belongs to one section, and its members should be in it. This is
    // a guard against a mistyped code landing somebody in a stranger's group.
    const mySection = String(req.profile.section ?? '').trim().toUpperCase();
    if (mySection && group.section && mySection !== group.section) {
      throw new HttpError(
        403,
        `That group is in section ${group.section} and you are in ${mySection}.`,
      );
    }

    await pool.query(
      `insert into public.thesis_group_members (group_id, profile_id, role)
            values ($1, $2, 'member')
       on conflict do nothing`,
      [group.id, req.profile.id],
    );
    await pool.query(`update public.profiles set group_name = $2 where id = $1`, [
      req.profile.id,
      group.name,
    ]);

    res.json({ group: await loadGroup(group.id) });
  }),
);

/**
 * POST /api/thesis-groups/leave
 *
 * The leader cannot walk out on a group that still has members -- somebody has
 * to be able to rename it and read the code -- so leadership passes to the
 * longest-standing member instead. The last one out deletes the group.
 */
app.post(
  '/api/thesis-groups/leave',
  requireAuth,
  asyncRoute(async (req, res) => {
    const groupId = req.profile.group_id;
    if (!groupId) throw new HttpError(409, 'You are not in a thesis group.');

    const client = await pool.connect();
    try {
      await client.query('begin');

      await client.query(
        `delete from public.thesis_group_members where group_id = $1 and profile_id = $2`,
        [groupId, req.profile.id],
      );

      const { rows: remaining } = await client.query(
        `select profile_id, role from public.thesis_group_members
          where group_id = $1
          order by joined_at asc`,
        [groupId],
      );

      if (!remaining.length) {
        // Nothing points at it any more. Consultations keep their own copy of
        // the name, and group_id goes null by the foreign key.
        await client.query(`delete from public.thesis_groups where id = $1`, [groupId]);
      } else if (!remaining.some((member) => member.role === 'leader')) {
        await client.query(
          `update public.thesis_group_members set role = 'leader'
            where group_id = $1 and profile_id = $2`,
          [groupId, remaining[0].profile_id],
        );
      }

      await client.query(`update public.profiles set group_name = null where id = $1`, [
        req.profile.id,
      ]);

      await client.query('commit');
      res.json({ ok: true });
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

/**
 * PATCH /api/thesis-groups/mine
 * Body: { name }
 *
 * Renaming, which only the leader may do. Past consultations keep the name they
 * were booked under: the printable record is a historical document, and
 * rewriting it to match a rename would be a lie about what was submitted.
 */
app.patch(
  '/api/thesis-groups/mine',
  requireAuth,
  asyncRoute(async (req, res) => {
    const groupId = req.profile.group_id;
    if (!groupId) throw new HttpError(409, 'You are not in a thesis group.');
    if (req.profile.group_role !== 'leader') {
      throw new HttpError(403, 'Only the group leader can rename the group.');
    }

    const name = String(req.body?.name ?? '').trim();
    if (name.length < 2 || name.length > 120) {
      throw new HttpError(400, 'Give the group a name of 2 to 120 characters.');
    }

    try {
      await pool.query(`update public.thesis_groups set name = $2 where id = $1`, [
        groupId,
        name,
      ]);
    } catch (err) {
      if (err.code === '23505') {
        throw new HttpError(409, 'Another group in your section already has that name.');
      }
      throw err;
    }

    await pool.query(
      `update public.profiles p
          set group_name = $2
         from public.thesis_group_members m
        where m.profile_id = p.id and m.group_id = $1`,
      [groupId, name],
    );

    res.json({ group: await loadGroup(groupId) });
  }),
);

/**
 * DELETE /api/thesis-groups/mine/members/:id
 *
 * The leader removing somebody. They cannot remove themselves this way -- that
 * is what leaving is for, and it has the succession rules.
 */
app.delete(
  '/api/thesis-groups/mine/members/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const groupId = req.profile.group_id;
    if (!groupId) throw new HttpError(409, 'You are not in a thesis group.');
    if (req.profile.group_role !== 'leader') {
      throw new HttpError(403, 'Only the group leader can remove a member.');
    }

    const memberId = String(req.params.id);
    if (!UUID_RE.test(memberId)) throw new HttpError(400, 'That member is not valid.');
    if (memberId === req.profile.id) {
      throw new HttpError(409, 'Use "leave group" to remove yourself.');
    }

    const { rowCount } = await pool.query(
      `delete from public.thesis_group_members where group_id = $1 and profile_id = $2`,
      [groupId, memberId],
    );
    if (!rowCount) throw new HttpError(404, 'They are not in your group.');

    await pool.query(`update public.profiles set group_name = null where id = $1`, [memberId]);

    res.json({ group: await loadGroup(groupId) });
  }),
);

/**
 * GET /api/thesis-groups/bookable
 *
 * The groups an adviser may schedule a session with: every group in their own
 * department, plus any they already advise.
 *
 * It deliberately is not limited to groups they have already met. That was the
 * first version and it could not work: a group's very first session is by
 * definition with an adviser who has never advised it, so a newly formed group
 * could never be booked at all and the session landed with no group attached --
 * invisible to the very members it was for.
 *
 * Department scoping is the same rule the adviser directory uses in the other
 * direction, so this exposes nothing a student could not already see about who
 * teaches their school.
 */
app.get(
  '/api/thesis-groups/bookable',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role !== 'adviser') return res.json({ groups: [] });

    const department = req.profile.department ?? null;

    const { rows } = await pool.query(
      `select g.id, g.name, g.section, g.department,
              (select count(*)::int from public.thesis_group_members m where m.group_id = g.id)
                as member_count
         from public.thesis_groups g
        where ($1::text is null or g.department is null or g.department = $1)
           or exists (
                select 1 from public.consultations c
                 where c.group_id = g.id and c.adviser_id = $2
              )
        order by g.section asc, g.name asc`,
      [department, req.profile.id],
    );

    res.json({ groups: rows, department });
  }),
);

/* ------------------------------------------------------- program-level -- */

/**
 * The capstone sequence a department measures its groups against.
 *
 * Falls back to the rows with a null department, which are the five steps the
 * app shipped with. A department that has defined its own gets only its own --
 * the two sets are alternatives, not layers.
 */
async function milestoneSequenceFor(department) {
  const { rows } = await pool.query(
    `select key, label, position
       from public.program_milestones
      where is_active and department = $1
      order by position asc`,
    [department ?? null],
  );
  if (rows.length) return rows;

  const { rows: fallback } = await pool.query(
    `select key, label, position
       from public.program_milestones
      where is_active and department is null
      order by position asc`,
  );
  return fallback;
}

/**
 * GET /api/program-milestones
 *
 * The sequence that applies to the caller. Everyone may read it: it is the
 * scale their own progress is drawn on.
 */
app.get(
  '/api/program-milestones',
  requireAuth,
  asyncRoute(async (req, res) => {
    const department =
      req.profile.is_coordinator && req.query.department
        ? String(req.query.department)
        : req.profile.department;

    res.json({ department: department ?? null, milestones: await milestoneSequenceFor(department) });
  }),
);

/**
 * PUT /api/coordinator/program-milestones
 * Body: { milestones: [{ key, label }] }
 *
 * Replaces the department's sequence outright, in order. Sending an empty list
 * deletes it, which puts the department back on the fallback set.
 *
 * Keys already recorded against a group are never deleted from that group's
 * history -- group_milestones has no foreign key here on purpose, so dropping a
 * step from the sequence hides it rather than rewriting what a group achieved.
 */
app.put(
  '/api/coordinator/program-milestones',
  requireAuth,
  requireCoordinator,
  asyncRoute(async (req, res) => {
    const department = req.profile.department;
    const incoming = Array.isArray(req.body?.milestones) ? req.body.milestones : null;
    if (!incoming) throw new HttpError(400, 'Send the milestones as a list.');
    if (incoming.length > 40) throw new HttpError(400, 'That is more steps than a capstone has.');

    const cleaned = [];
    const seen = new Set();
    for (const [index, item] of incoming.entries()) {
      const label = String(item?.label ?? '').trim();
      if (!label) throw new HttpError(400, 'Every step needs a name.');
      if (label.length > 80) throw new HttpError(400, `"${label.slice(0, 20)}..." is too long.`);

      // A key given by the client is kept, so renaming a label does not orphan
      // the progress already recorded against it.
      const key =
        String(item?.key ?? '').trim() ||
        label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
      if (!/^[a-z0-9_]{2,40}$/.test(key)) {
        throw new HttpError(400, `"${label}" does not make a usable key. Rename it.`);
      }
      if (seen.has(key)) throw new HttpError(409, `Two steps resolve to the same key ("${key}").`);
      seen.add(key);
      cleaned.push({ key, label, position: index + 1 });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`delete from public.program_milestones where department = $1`, [department]);
      for (const item of cleaned) {
        await client.query(
          `insert into public.program_milestones (department, key, label, position)
                values ($1, $2, $3, $4)`,
          [department, item.key, item.label, item.position],
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ department, milestones: await milestoneSequenceFor(department) });
  }),
);

/**
 * GET /api/coordinator/overview
 *
 * Every group in the coordinator's department, with the two things they are
 * actually looking for: who advises it, and whether it has gone quiet.
 *
 * "Quiet" is measured from the last session that has happened, not the last one
 * booked, because a group with a booking three weeks out and nothing since
 * February is exactly the case this view exists to surface.
 */
app.get(
  '/api/coordinator/overview',
  requireAuth,
  requireCoordinator,
  asyncRoute(async (req, res) => {
    const department = req.profile.department;
    const sequence = await milestoneSequenceFor(department);
    const keys = sequence.map((item) => item.key);

    const { rows } = await pool.query(
      `select g.id,
              g.name,
              g.section,
              g.created_at,
              a.id                as adviser_id,
              a.full_name         as adviser_name,
              (select count(*)::int from public.thesis_group_members m where m.group_id = g.id)
                                  as member_count,
              (select count(*)::int from public.consultations c
                where c.group_id = g.id and c.status = 'completed')
                                  as sessions_held,
              (select count(*)::int from public.consultations c
                where c.group_id = g.id and c.status = 'pending')
                                  as awaiting_approval,
              (select max(c.meeting_date) from public.consultations c
                where c.group_id = g.id
                  and (c.status = 'completed' or (c.status = 'scheduled' and c.meeting_date < now())))
                                  as last_session,
              (select min(c.meeting_date) from public.consultations c
                where c.group_id = g.id and c.status = 'scheduled' and c.meeting_date >= now())
                                  as next_session,
              (select count(*)::int from public.group_milestones gm
                where gm.group_id = g.id and gm.milestone = any($2::text[]))
                                  as milestones_done,
              (select count(*)::int from public.action_items ai
                 join public.consultations c on c.id = ai.consultation_id
                where c.group_id = g.id and ai.status = 'pending')
                                  as open_tasks
         from public.thesis_groups g
         left join public.profiles a on a.id = g.adviser_id
        where g.department = $1 or g.department is null
        order by g.section asc, g.name asc`,
      [department, keys],
    );

    res.json({
      department,
      milestone_count: sequence.length,
      groups: rows.map((row) => ({
        ...row,
        progress: sequence.length
          ? Math.round((row.milestones_done / sequence.length) * 100)
          : 0,
      })),
    });
  }),
);

/**
 * GET /api/coordinator/advisers
 *
 * The department's advisers, with how many groups they carry against the cap
 * they accept. This is the view an assignment is made from.
 */
app.get(
  '/api/coordinator/advisers',
  requireAuth,
  requireCoordinator,
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `select p.id, p.full_name, p.email, p.faculty_position, p.adviser_capacity,
              (select count(*)::int from public.thesis_groups g where g.adviser_id = p.id)
                as assigned_groups,
              (select count(*)::int from public.adviser_availability a
                where a.adviser_id = p.id and a.is_active)
                as hour_blocks
         from public.profiles p
        where p.role = 'adviser'
          and p.registration_completed_at is not null
          and (p.department = $1 or p.department is null)
        order by p.full_name asc`,
      [req.profile.department],
    );

    res.json({ advisers: rows });
  }),
);

/**
 * PATCH /api/coordinator/advisers/:id
 * Body: { capacity }
 *
 * The cap an adviser accepts. Null clears it back to unlimited.
 */
app.patch(
  '/api/coordinator/advisers/:id',
  requireAuth,
  requireCoordinator,
  asyncRoute(async (req, res) => {
    const adviserId = String(req.params.id);
    if (!UUID_RE.test(adviserId)) throw new HttpError(400, 'That adviser is not valid.');

    const raw = req.body?.capacity;
    const capacity = raw === null || raw === '' ? null : Number.parseInt(raw, 10);
    if (capacity !== null && (!Number.isFinite(capacity) || capacity < 0 || capacity > 99)) {
      throw new HttpError(400, 'A capacity is a number between 0 and 99, or empty for no limit.');
    }

    const { rows } = await pool.query(
      `update public.profiles set adviser_capacity = $2
        where id = $1 and role = 'adviser' and (department = $3 or department is null)
    returning id, full_name, adviser_capacity`,
      [adviserId, capacity, req.profile.department],
    );
    if (!rows[0]) throw new HttpError(404, 'That adviser is not in your department.');

    res.json({ adviser: rows[0] });
  }),
);

/**
 * PATCH /api/coordinator/groups/:id/adviser
 * Body: { adviserId }   (null to unassign)
 *
 * Assigning refuses to push an adviser past the cap they accept. Unassigning
 * puts the group back to choosing per booking, which is how the app worked
 * before assignment existed.
 */
app.patch(
  '/api/coordinator/groups/:id/adviser',
  requireAuth,
  requireCoordinator,
  asyncRoute(async (req, res) => {
    const groupId = String(req.params.id);
    if (!UUID_RE.test(groupId)) throw new HttpError(400, 'That group is not valid.');

    const { rows: groups } = await pool.query(
      `select id, name, department from public.thesis_groups where id = $1 limit 1`,
      [groupId],
    );
    const group = groups[0];
    if (!group) throw new HttpError(404, 'That group was not found.');
    if (group.department && group.department !== req.profile.department) {
      throw new HttpError(403, 'That group is in another department.');
    }

    const raw = req.body?.adviserId;
    if (raw === null || raw === '') {
      const { rows } = await pool.query(
        `update public.thesis_groups
            set adviser_id = null, adviser_assigned_at = null, adviser_assigned_by = null
          where id = $1
      returning id, adviser_id`,
        [groupId],
      );
      return res.json({ group: rows[0] });
    }

    const adviserId = String(raw);
    if (!UUID_RE.test(adviserId)) throw new HttpError(400, 'That adviser is not valid.');

    const { rows: advisers } = await pool.query(
      `select p.id, p.full_name, p.adviser_capacity,
              (select count(*)::int from public.thesis_groups g
                where g.adviser_id = p.id and g.id <> $2) as assigned_groups
         from public.profiles p
        where p.id = $1 and p.role = 'adviser'
          and p.registration_completed_at is not null
          and (p.department = $3 or p.department is null)
        limit 1`,
      [adviserId, groupId, req.profile.department],
    );
    const adviser = advisers[0];
    if (!adviser) throw new HttpError(404, 'That adviser is not in your department.');

    if (adviser.adviser_capacity !== null && adviser.assigned_groups >= adviser.adviser_capacity) {
      throw new HttpError(
        409,
        `${adviser.full_name} already carries ${adviser.assigned_groups} of ${adviser.adviser_capacity} groups.`,
      );
    }

    const { rows } = await pool.query(
      `update public.thesis_groups
          set adviser_id = $2, adviser_assigned_at = now(), adviser_assigned_by = $3
        where id = $1
    returning id, adviser_id, adviser_assigned_at`,
      [groupId, adviserId, req.profile.id],
    );

    res.json({ group: { ...rows[0], adviser_name: adviser.full_name } });
  }),
);

/* ------------------------------------------------------------- panelists -- */

/**
 * GET /api/consultations/:id/panelists
 *
 * Who else is sitting on this session. Anyone who can see the consultation can
 * see its panel: a group facing a defense is entitled to know who is on it.
 */
app.get(
  '/api/consultations/:id/panelists',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);
    const { rows } = await pool.query(
      `select p.id, p.full_name, p.email, p.faculty_position, cp.role, cp.added_at
         from public.consultation_panelists cp
         join public.profiles p on p.id = cp.adviser_id
        where cp.consultation_id = $1
        order by (cp.role = 'chair') desc, p.full_name asc`,
      [consultation.id],
    );
    res.json({ panelists: rows });
  }),
);

/**
 * POST /api/consultations/:id/panelists
 * Body: { adviserId, role? }
 *
 * Only the lead adviser builds the panel. They own the slot the session sits
 * in, and a panel a student could assemble would not be a panel.
 */
app.post(
  '/api/consultations/:id/panelists',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);
    if (consultation.adviser_id !== req.profile.id) {
      throw new HttpError(403, 'Only the lead adviser can add to the panel.');
    }

    const adviserId = String(req.body?.adviserId ?? '');
    if (!UUID_RE.test(adviserId)) throw new HttpError(400, 'That adviser is not valid.');
    if (adviserId === consultation.adviser_id) {
      throw new HttpError(409, 'The lead adviser is already on the panel.');
    }

    const role = req.body?.role === 'chair' ? 'chair' : 'panelist';

    const { rows: found } = await pool.query(
      `select id, full_name, email, faculty_position from public.profiles
        where id = $1 and role = 'adviser' and registration_completed_at is not null
          and (department = $2 or department is null or $2 is null)
        limit 1`,
      [adviserId, req.profile.department ?? null],
    );
    if (!found.length) throw new HttpError(404, 'That adviser was not found in your department.');

    await pool.query(
      `insert into public.consultation_panelists (consultation_id, adviser_id, role, added_by)
            values ($1, $2, $3, $4)
       on conflict (consultation_id, adviser_id) do update set role = excluded.role`,
      [consultation.id, adviserId, role, req.profile.id],
    );

    res.status(201).json({ panelist: { ...found[0], role } });
  }),
);

/** DELETE /api/consultations/:id/panelists/:adviserId */
app.delete(
  '/api/consultations/:id/panelists/:adviserId',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);
    if (consultation.adviser_id !== req.profile.id) {
      throw new HttpError(403, 'Only the lead adviser can change the panel.');
    }
    const adviserId = String(req.params.adviserId);
    if (!UUID_RE.test(adviserId)) throw new HttpError(400, 'That adviser is not valid.');

    await pool.query(
      `delete from public.consultation_panelists
        where consultation_id = $1 and adviser_id = $2`,
      [consultation.id, adviserId],
    );
    res.json({ ok: true });
  }),
);

/* -------------------------------------------------------------- feedback -- */

/**
 * POST /api/consultations/:id/feedback
 * Body: { rating (1-5), comment? }
 *
 * Only a group member, and only once the session has actually happened. An
 * adviser rating their own session would be marking their own work.
 */
app.post(
  '/api/consultations/:id/feedback',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);
    if (req.profile.role === 'adviser') {
      throw new HttpError(403, 'Feedback comes from the group.');
    }
    if (consultation.status !== 'completed') {
      throw new HttpError(409, 'You can rate a session once it has been wrapped up.');
    }

    const rating = Number.parseInt(req.body?.rating, 10);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'Give the session a rating from 1 to 5.');
    }
    const comment = String(req.body?.comment ?? '').trim().slice(0, 1000) || null;

    const { rows } = await pool.query(
      `insert into public.consultation_feedback (consultation_id, profile_id, rating, comment)
            values ($1, $2, $3, $4)
       on conflict (consultation_id, profile_id) do update
              set rating = excluded.rating, comment = excluded.comment, created_at = now()
         returning rating, comment, created_at`,
      [consultation.id, req.profile.id, rating, comment],
    );

    res.json({ feedback: rows[0] });
  }),
);

/**
 * GET /api/consultations/:id/feedback
 *
 * A student sees their own answer. An adviser sees the average and the comments
 * with no names on them: a student answering honestly should not be answering to
 * the person they are rating.
 */
app.get(
  '/api/consultations/:id/feedback',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    if (req.profile.role !== 'adviser') {
      const { rows } = await pool.query(
        `select rating, comment, created_at from public.consultation_feedback
          where consultation_id = $1 and profile_id = $2 limit 1`,
        [consultation.id, req.profile.id],
      );
      return res.json({ mine: rows[0] ?? null });
    }

    const { rows } = await pool.query(
      `select count(*)::int as responses,
              round(avg(rating)::numeric, 1)::float as average,
              coalesce(
                json_agg(comment order by created_at desc) filter (where comment is not null),
                '[]'::json
              ) as comments
         from public.consultation_feedback
        where consultation_id = $1`,
      [consultation.id],
    );

    res.json({ summary: rows[0] });
  }),
);

/* -------------------------------------------------------- activity trail -- */

/**
 * GET /api/consultations/:id/activity
 *
 * What has happened to this session, in order.
 *
 * Assembled from the columns the workflow already writes -- who proposed a move,
 * who cancelled and why, when the adviser answered -- none of which had anywhere
 * to be seen. There is no event table; there does not need to be, because every
 * one of these transitions is already stamped.
 */
app.get(
  '/api/consultations/:id/activity',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    const { rows } = await pool.query(
      `select c.created_at, c.responded_at, c.status, c.decline_reason,
              c.proposed_at, c.proposed_note, c.proposed_date,
              c.cancelled_at, c.cancel_reason, c.completed_at,
              cb.full_name as created_by_name,
              pb.full_name as proposed_by_name,
              xb.full_name as cancelled_by_name,
              ab.full_name as adviser_name
         from public.consultations c
         left join public.profiles cb on cb.id = c.created_by
         left join public.profiles pb on pb.id = c.proposed_by
         left join public.profiles xb on xb.id = c.cancelled_by
         left join public.profiles ab on ab.id = c.adviser_id
        where c.id = $1
        limit 1`,
      [consultation.id],
    );
    const row = rows[0];
    const events = [];

    if (row.created_at) {
      events.push({ at: row.created_at, kind: 'requested', who: row.created_by_name, detail: null });
    }
    if (row.responded_at) {
      events.push({
        at: row.responded_at,
        kind: row.status === 'declined' ? 'declined' : 'approved',
        who: row.adviser_name,
        detail: row.decline_reason,
      });
    }
    if (row.proposed_at) {
      events.push({
        at: row.proposed_at,
        kind: 'proposed',
        who: row.proposed_by_name,
        detail: row.proposed_note,
        when: row.proposed_date,
      });
    }
    if (row.cancelled_at) {
      events.push({
        at: row.cancelled_at,
        kind: 'cancelled',
        who: row.cancelled_by_name,
        detail: row.cancel_reason,
      });
    }
    if (row.completed_at) {
      events.push({ at: row.completed_at, kind: 'completed', who: row.adviser_name, detail: null });
    }

    events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    res.json({ events });
  }),
);

/* ---------------------------------------------------------------- search -- */

/**
 * GET /api/search?q=...
 *
 * One query across everything the caller may see.
 *
 * The dashboard used to filter the rows it had already loaded, which meant a
 * search for a session from last term, or a task somebody has since ticked off,
 * found nothing at all. This reaches the tables, so it finds what is actually
 * there rather than what happens to be on screen.
 */
app.get(
  '/api/search',
  requireAuth,
  asyncRoute(async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    if (term.length < 2) return res.json({ results: [] });

    // ILIKE with both wildcards escaped, so a term containing % or _ searches
    // for those characters rather than matching everything.
    const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const { id, role, group_name: groupName, group_id: groupId } = req.profile;
    const args = [id, role, groupName, groupId, pattern];

    const { rows: consultations } = await pool.query(
      `select c.id, c.topic, c.group_name, c.meeting_date, c.status, c.location
         from public.consultations c
        where (
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and ${groupVisibility({ creator: '$1', groupId: '$4', groupName: '$3' })})
              )
          and (c.topic ilike $5 or c.group_name ilike $5
               or c.location ilike $5 or c.minutes ilike $5)
        order by c.meeting_date desc
        limit 8`,
      args,
    );

    const { rows: tasks } = await pool.query(
      `select a.id, a.task_description, a.status, a.due_date,
              c.id as consultation_id, c.topic as consultation_topic
         from public.action_items a
         join public.consultations c on c.id = a.consultation_id
        where (
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and (a.assignee_id = $1 or ${groupVisibility({ creator: '$1', groupId: '$4', groupName: '$3' })}))
              )
          and a.task_description ilike $5
        order by (a.status = 'pending') desc, a.created_at desc
        limit 8`,
      args,
    );

    const { rows: messages } = await pool.query(
      `select m.id, m.body, m.created_at, c.id as consultation_id, c.topic,
              p.full_name as sender_name
         from public.consultation_messages m
         join public.consultations c on c.id = m.consultation_id
         left join public.profiles p on p.id = m.sender_id
        where (
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and ${groupVisibility({ creator: '$1', groupId: '$4', groupName: '$3' })})
              )
          and m.body ilike $5
        order by m.created_at desc
        limit 6`,
      args,
    );

    // Groups: a student's own, an adviser's advised, a coordinator's department.
    const { rows: groups } = await pool.query(
      `select g.id, g.name, g.section
         from public.thesis_groups g
        where g.name ilike $2
          and (
               exists (select 1 from public.thesis_group_members m
                        where m.group_id = g.id and m.profile_id = $1)
            or g.adviser_id = $1
            or exists (select 1 from public.consultations c
                        where c.group_id = g.id and c.adviser_id = $1)
            or ($3::boolean and g.department = $4)
          )
        order by g.name asc
        limit 6`,
      [id, pattern, Boolean(req.profile.is_coordinator), req.profile.department ?? null],
    );

    res.json({ results: { consultations, tasks, messages, groups } });
  }),
);

/* ------------------------------------------------------------- calendar -- */

/**
 * GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Sessions in a date range, which is what a week or month view needs. The list
 * endpoints answer "the next N", which cannot fill a grid.
 *
 * Capped at 62 days so a mistyped range cannot ask for a decade.
 */
app.get(
  '/api/calendar',
  requireAuth,
  asyncRoute(async (req, res) => {
    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new HttpError(400, 'Pass from and to as YYYY-MM-DD.');
    }
    const span = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000;
    if (!Number.isFinite(span) || span < 0) throw new HttpError(400, 'That range runs backwards.');
    if (span > 62) throw new HttpError(400, 'Ask for at most two months at a time.');

    const { id, role, group_name: groupName, group_id: groupId } = req.profile;

    const { rows } = await pool.query(
      `select c.id, c.topic, c.group_name, c.location, c.meeting_date, c.status,
              p.full_name as adviser_name,
              (select count(*)::int from public.consultation_panelists cp
                where cp.consultation_id = c.id) as panel_size
         from public.consultations c
         left join public.profiles p on p.id = c.adviser_id
        where c.status in ('pending', 'scheduled', 'completed')
          and c.meeting_date >= ($5::date at time zone $7)
          and c.meeting_date <  (($6::date + 1) at time zone $7)
          and (
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and ${groupVisibility({ creator: '$1', groupId: '$4', groupName: '$3' })})
          )
        order by c.meeting_date asc`,
      [id, role, groupName, groupId, from, to, CAMPUS_TIMEZONE],
    );

    res.json({ from, to, timezone: CAMPUS_TIMEZONE, consultations: rows });
  }),
);

/* -------------------------------------------------- record submissions ---- */

/**
 * POST /api/record/submit
 * Body: { group_id, note? }
 *
 * Freezes the record as it stands and files it.
 *
 * The record is generated from live rows, so it changes whenever anything
 * behind it does. That is right for a working document and wrong for a
 * submission: "this is what we handed in" is only a checkable claim if a copy
 * was kept. The snapshot is the record's own JSON rather than a PDF -- a PDF
 * needs a headless browser this deployment does not have, and would be no more
 * trustworthy than the rows it came from. Printing is unchanged.
 */
app.post(
  '/api/record/submit',
  requireAuth,
  asyncRoute(async (req, res) => {
    const groupId = String(req.body?.group_id ?? '').trim();
    if (!UUID_RE.test(groupId)) throw new HttpError(400, 'Name the group whose record you are submitting.');

    // Only the group itself hands its record in.
    if (req.profile.group_id !== groupId) {
      throw new HttpError(403, 'Only the group can submit its own record.');
    }

    const snapshot = req.body?.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.sessions)) {
      throw new HttpError(400, 'Nothing to submit.');
    }
    if (!snapshot.sessions.length) {
      throw new HttpError(409, 'There are no sessions on this record yet.');
    }

    const note = String(req.body?.note ?? '').trim().slice(0, 500) || null;

    const { rows } = await pool.query(
      `insert into public.record_submissions
              (group_id, submitted_by, session_count, note, snapshot)
            values ($1, $2, $3, $4, $5)
         returning id, submitted_at, session_count, note`,
      [groupId, req.profile.id, snapshot.sessions.length, note, JSON.stringify(snapshot)],
    );

    res.status(201).json({ submission: rows[0] });
  }),
);

/**
 * GET /api/record/submissions?group_id=...
 *
 * The trail: every time this record was handed in, and by whom. Readable by the
 * group and by whoever advises it.
 */
app.get(
  '/api/record/submissions',
  requireAuth,
  asyncRoute(async (req, res) => {
    const groupId = String(req.query.group_id ?? '').trim();
    if (!UUID_RE.test(groupId)) throw new HttpError(400, 'That group is not valid.');

    const { rows: allowed } = await pool.query(
      `select 1
         from public.thesis_groups g
        where g.id = $1
          and (
               exists (select 1 from public.thesis_group_members m
                        where m.group_id = g.id and m.profile_id = $2)
            or g.adviser_id = $2
            or exists (select 1 from public.consultations c
                        where c.group_id = g.id and c.adviser_id = $2)
            or ($3::boolean and g.department = $4)
          )
        limit 1`,
      [groupId, req.profile.id, Boolean(req.profile.is_coordinator), req.profile.department ?? null],
    );
    if (!allowed.length) throw new HttpError(403, 'That is not your group.');

    const { rows } = await pool.query(
      `select r.id, r.submitted_at, r.session_count, r.note,
              p.full_name as submitted_by_name
         from public.record_submissions r
         left join public.profiles p on p.id = r.submitted_by
        where r.group_id = $1
        order by r.submitted_at desc
        limit 20`,
      [groupId],
    );

    res.json({ submissions: rows });
  }),
);

/* ----------------------------------------------------------- attachments -- */

const ATTACHMENT_BUCKET = 'consultation-attachments';
const MAX_ATTACHMENTS_PER_CONSULTATION = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Mirrors allowed_mime_types on the bucket. Kept here too so a rejection is a
// readable 400 rather than a storage error the user cannot act on.
const ATTACHMENT_TYPES = new Map([
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['text/plain', '.txt'],
]);

/**
 * A Supabase client acting as the signed-in user.
 *
 * Storage RLS is written against auth.uid(), so uploading with the shared anon
 * client would be an anonymous write and would be refused. This borrows the
 * caller's own token for the one call that needs it.
 */
function storageAs(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Strips anything that could steer a path or a Content-Disposition header. */
function safeFileName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[/\\]/g, '-')
    .trim()
    .slice(0, 120);
  return cleaned || 'attachment';
}

/**
 * GET /api/consultations/:id/attachments
 *
 * The listing. Reads the metadata table only -- the bucket is never enumerated,
 * so a stray object with no row is invisible to the app.
 */
app.get(
  '/api/consultations/:id/attachments',
  requireAuth,
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    const { rows } = await pool.query(
      `select a.id, a.file_name, a.content_type, a.byte_size, a.created_at,
              p.full_name as uploaded_by_name
         from public.consultation_attachments a
         left join public.profiles p on p.id = a.uploaded_by
        where a.consultation_id = $1
        order by a.created_at asc`,
      [consultation.id],
    );

    res.json({ attachments: rows });
  }),
);

/**
 * POST /api/consultations/:id/attachments?name=<filename>&type=<mime>
 * Body: the raw bytes, as application/octet-stream.
 *
 * Raw rather than multipart because one file per request keeps the parser out
 * of the dependency list, and the client uploads them one at a time anyway so
 * it can report which one failed.
 *
 * The stored path is `<consultation id>/<uuid><ext>` and never contains the
 * uploaded filename: two groups both sending "Chapter4.docx" must not collide,
 * and a filename is attacker-controlled input to a path.
 */
app.post(
  '/api/consultations/:id/attachments',
  requireAuth,
  express.raw({ type: 'application/octet-stream', limit: MAX_ATTACHMENT_BYTES }),
  asyncRoute(async (req, res) => {
    const consultation = await loadConsultationFor(req.profile, req.params.id);

    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes?.length) throw new HttpError(400, 'That file was empty.');
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new HttpError(413, 'Files are limited to 10 MB.');
    }

    const contentType = String(req.query.type ?? '').trim().toLowerCase();
    if (!ATTACHMENT_TYPES.has(contentType)) {
      throw new HttpError(415, 'Attach a PDF, Word or PowerPoint file, an image, or plain text.');
    }

    const fileName = safeFileName(req.query.name);

    const { rows: existing } = await pool.query(
      `select count(*)::int as count from public.consultation_attachments
        where consultation_id = $1`,
      [consultation.id],
    );
    if (existing[0].count >= MAX_ATTACHMENTS_PER_CONSULTATION) {
      throw new HttpError(
        409,
        `A consultation can carry ${MAX_ATTACHMENTS_PER_CONSULTATION} files.`,
      );
    }

    const storagePath = `${consultation.id}/${randomUUID()}${ATTACHMENT_TYPES.get(contentType)}`;

    const { error: uploadError } = await storageAs(req.accessToken)
      .storage.from(ATTACHMENT_BUCKET)
      .upload(storagePath, bytes, { contentType, upsert: false });

    if (uploadError) {
      throw new HttpError(502, `Could not store that file: ${uploadError.message}`);
    }

    try {
      const { rows } = await pool.query(
        `insert into public.consultation_attachments
                (consultation_id, storage_path, file_name, content_type, byte_size, uploaded_by)
              values ($1, $2, $3, $4, $5, $6)
           returning id, file_name, content_type, byte_size, created_at`,
        [consultation.id, storagePath, fileName, contentType, bytes.length, req.profile.id],
      );
      res.status(201).json({ attachment: rows[0] });
    } catch (err) {
      // The bytes landed but the row did not, which would leave a file nothing
      // can reach. Take the object back out rather than leak it.
      await storageAs(req.accessToken)
        .storage.from(ATTACHMENT_BUCKET)
        .remove([storagePath])
        .catch(() => {});
      throw err;
    }
  }),
);

/**
 * GET /api/attachments/:id/url
 *
 * A short-lived signed URL. The bucket is private, so this is the only way to
 * read a file, and it is minted only for someone who already passes the
 * consultation's own visibility check.
 */
app.get(
  '/api/attachments/:id/url',
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) throw new HttpError(400, 'That attachment is not valid.');

    const { rows } = await pool.query(
      `select id, consultation_id, storage_path, file_name
         from public.consultation_attachments
        where id = $1
        limit 1`,
      [id],
    );
    const attachment = rows[0];
    if (!attachment) throw new HttpError(404, 'That file was not found.');

    // Throws 403/404 unless the caller may see the consultation it hangs off.
    await loadConsultationFor(req.profile, attachment.consultation_id);

    const { data, error } = await storageAs(req.accessToken)
      .storage.from(ATTACHMENT_BUCKET)
      .createSignedUrl(attachment.storage_path, 120, { download: attachment.file_name });

    if (error || !data?.signedUrl) {
      throw new HttpError(502, 'Could not open that file.');
    }

    res.json({ url: data.signedUrl, fileName: attachment.file_name });
  }),
);

/**
 * DELETE /api/attachments/:id
 *
 * Only whoever sent the file may take it back, and only while the consultation
 * has not been wrapped up -- the record cites what was submitted.
 */
app.delete(
  '/api/attachments/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) throw new HttpError(400, 'That attachment is not valid.');

    const { rows } = await pool.query(
      `select id, consultation_id, storage_path, uploaded_by
         from public.consultation_attachments
        where id = $1
        limit 1`,
      [id],
    );
    const attachment = rows[0];
    if (!attachment) throw new HttpError(404, 'That file was not found.');

    const consultation = await loadConsultationFor(req.profile, attachment.consultation_id);
    if (attachment.uploaded_by !== req.profile.id) {
      throw new HttpError(403, 'Only whoever attached that file can remove it.');
    }
    if (consultation.status === 'completed') {
      throw new HttpError(409, 'That session is wrapped up; its files are part of the record.');
    }

    await pool.query(`delete from public.consultation_attachments where id = $1`, [id]);
    await storageAs(req.accessToken)
      .storage.from(ATTACHMENT_BUCKET)
      .remove([attachment.storage_path])
      .catch(() => {});

    res.json({ id });
  }),
);

/* ------------------------------------------------------------ milestones -- */

/**
 * The sequence a group is measured against, as keys.
 *
 * Read from program_milestones rather than hard-coded: the five steps that used
 * to live here describe one program, and a department that has defined its own
 * gets those instead. The old list survives as the seeded fallback row set.
 */
async function milestoneKeysFor(department) {
  const sequence = await milestoneSequenceFor(department);
  return sequence.map((item) => item.key);
}

/** Which department's sequence a group is held to. */
async function departmentOfGroup(groupId) {
  const { rows } = await pool.query(
    `select department from public.thesis_groups where id = $1 limit 1`,
    [groupId],
  );
  return rows[0]?.department ?? null;
}

/**
 * Which group's milestones this caller is asking about.
 *
 * A student may only ever see their own, so the query string is ignored for
 * them. An adviser has to name one by id, and only gets it if they actually
 * hold a consultation with that group -- otherwise the endpoint would enumerate
 * every group in the school.
 */
async function resolveMilestoneGroup(profile, requested) {
  if (profile.role !== 'adviser') return profile.group_id ?? null;

  const groupId = String(requested ?? '').trim();
  if (!UUID_RE.test(groupId)) return null;

  const { rows } = await pool.query(
    `select 1 from public.consultations
      where group_id = $1 and adviser_id = $2
      limit 1`,
    [groupId, profile.id],
  );
  return rows.length ? groupId : null;
}

/** Throws unless this adviser has a consultation with that group. */
async function assertAdvisesGroup(profile, groupId) {
  const { rows } = await pool.query(
    `select 1 from public.consultations
      where group_id = $1 and adviser_id = $2
      limit 1`,
    [groupId, profile.id],
  );
  if (!rows.length) {
    throw new HttpError(403, 'You do not advise that group.');
  }
}

/**
 * GET /api/milestones?group=<group id>
 *
 * A group's capstone progress. Students get their own group and nothing else;
 * an adviser names the group they want. An unknown or unadvised group comes back
 * empty rather than 403, because "no progress recorded" and "not your group"
 * look the same from a dashboard and only one of them is worth an error.
 */
app.get(
  '/api/milestones',
  requireAuth,
  asyncRoute(async (req, res) => {
    const groupId = await resolveMilestoneGroup(req.profile, req.query.group);
    if (!groupId) {
      return res.json({
        groupId: null,
        order: await milestoneKeysFor(req.profile.department),
        milestones: [],
      });
    }

    const { rows } = await pool.query(
      `select m.milestone,
              m.completed_at,
              m.consultation_id,
              p.full_name as completed_by_name
         from public.group_milestones m
         left join public.profiles p on p.id = m.completed_by
        where m.group_id = $1`,
      [groupId],
    );

    res.json({
      groupId,
      order: await milestoneKeysFor(await departmentOfGroup(groupId)),
      milestones: rows,
    });
  }),
);

/**
 * PUT /api/milestones/:milestone
 * Body: { groupId, completed?: boolean, consultationId?: uuid }
 *
 * Marks one milestone reached, or clears it again with `completed: false`. Only
 * the group's own adviser may write: a milestone is their evaluation of the
 * group, not the group's claim about itself.
 */
app.put(
  '/api/milestones/:milestone',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.profile.role !== 'adviser') {
      throw new HttpError(403, 'Only an adviser can mark a milestone.');
    }

    const milestone = String(req.params.milestone ?? '');
    // Validated against the group's own sequence, further down, once we know
    // which group it is. Shape-checked here.
    if (!/^[a-z0-9_]{2,40}$/.test(milestone)) {
      throw new HttpError(400, 'That is not a capstone milestone.');
    }

    const groupId = String(req.body?.groupId ?? '').trim();
    if (!UUID_RE.test(groupId)) {
      throw new HttpError(400, 'Name the group this milestone belongs to.');
    }
    await assertAdvisesGroup(req.profile, groupId);

    const allowed = await milestoneKeysFor(await departmentOfGroup(groupId));
    if (!allowed.includes(milestone)) {
      throw new HttpError(400, 'That milestone is not in this group\'s capstone sequence.');
    }

    const completed = req.body?.completed !== false;

    if (!completed) {
      await pool.query(
        `delete from public.group_milestones where group_id = $1 and milestone = $2`,
        [groupId, milestone],
      );
      return res.json({ groupId, milestone, completed: false });
    }

    const consultationId =
      typeof req.body?.consultationId === 'string' && UUID_RE.test(req.body.consultationId)
        ? req.body.consultationId
        : null;

    const { rows } = await pool.query(
      `insert into public.group_milestones
              (group_id, milestone, completed_by, consultation_id)
            values ($1, $2, $3, $4)
       on conflict (group_id, milestone) do update
              set completed_at = now(),
                  completed_by = excluded.completed_by,
                  consultation_id = coalesce(excluded.consultation_id, public.group_milestones.consultation_id)
         returning milestone, completed_at, consultation_id`,
      [groupId, milestone, req.profile.id, consultationId],
    );

    res.json({ groupId, completed: true, ...rows[0] });
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
    const attendance = normalizeAttendance(req.body?.attendance);
    // Optional: the session that finished a capstone milestone signs it off in
    // the same breath, because the wrap-up is the only moment anyone knows.
    const requestedMilestone = String(req.body?.milestone ?? '');
    const milestone =
      requestedMilestone && consultation.group_id
        ? (await milestoneKeysFor(await departmentOfGroup(consultation.group_id))).includes(
            requestedMilestone,
          )
          ? requestedMilestone
          : null
        : null;

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

      // Attendance is part of the same attestation as the minutes, so it is
      // part of the same transaction. Re-running a wrap-up would overwrite
      // rather than duplicate.
      for (const entry of attendance) {
        await client.query(
          `insert into public.consultation_attendance
                  (consultation_id, profile_id, present)
                values ($1, $2, $3)
           on conflict (consultation_id, profile_id) do update
                  set present = excluded.present, recorded_at = now()`,
          [consultation.id, entry.profileId, entry.present],
        );
      }

      // Part of the same attestation as the minutes, so part of the same
      // transaction. A group with no name cannot carry group-level progress.
      // A session booked before groups existed has no group to credit, so its
      // wrap-up cannot move a tracker.
      if (milestone && consultation.group_id) {
        await client.query(
          `insert into public.group_milestones
                  (group_id, milestone, completed_by, consultation_id)
                values ($1, $2, $3, $4)
           on conflict (group_id, milestone) do update
                  set completed_at = now(),
                      completed_by = excluded.completed_by,
                      consultation_id = excluded.consultation_id`,
          [consultation.group_id, milestone, req.profile.id, consultation.id],
        );
      }

      await client.query('commit');
      res.json({
        consultation: rows[0],
        tasks: created,
        attendance: attendance.length,
        milestone: milestone && consultation.group_id ? milestone : null,
      });
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
 * Validates the attendance rows from a wrap-up. Only an explicit true/false is
 * kept: a member the adviser never ticked either way gets no row, which is how
 * "not recorded" stays distinct from "absent".
 */
function normalizeAttendance(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry) => {
      const profileId = entry?.profile_id ? String(entry.profile_id) : null;
      if (!profileId || !UUID_RE.test(profileId)) return null;
      if (typeof entry.present !== 'boolean') return null;
      return { profileId, present: entry.present };
    })
    .filter(Boolean)
    .slice(0, 50);
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

    const { id, role, group_name: groupName, group_id: groupId } = req.profile;

    const { rows } = await pool.query(
      `update public.action_items a
          set status = $4,
              resolved_at = case when $4 = 'resolved' then now() else null end
         from public.consultations c
        where c.id = a.consultation_id
          and a.id = $5
          and (
                ($2 = 'adviser' and ${adviserVisibility('$1')})
             or ($2 <> 'adviser' and (a.assignee_id = $1 or ${groupVisibility({ creator: '$1', groupId: '$6', groupName: '$3' })}))
          )
    returning a.id, a.task_description, a.status`,
      [id, role, groupName, status, req.params.id, groupId],
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
