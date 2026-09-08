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
// Loose on purpose - confirm HAU's real student-number format and tighten this.
const STUDENT_ID_RE = /^[0-9-]{6,20}$/;

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

const PROFILE_COLUMNS = `id, full_name, email, role, group_name,
                         last_name, first_name, middle_initial,
                         student_id, department, course, email_verified_at`;

/** "Dela Cruz, Juan M." */
function composeFullName({ lastName, firstName, middleInitial }) {
  const initial = middleInitial ? ` ${middleInitial.toUpperCase()}.` : '';
  return `${lastName}, ${firstName}${initial}`;
}

/**
 * Sends the 6-digit code through the Magic Link template.
 *
 * Deliberately not Supabase's signup-confirmation email: this project's "Confirm
 * signup" template does not apply, so that path delivers a link instead of a
 * code. Requires "Confirm email" to be OFF in Supabase, which makes signUp
 * auto-confirm the address and leaves signInWithOtp on the magiclink path.
 */
async function sendAccessCode(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (error) {
    const status = error.status === 429 ? 429 : 400;
    throw new HttpError(status, error.message || 'Could not send the access code.');
  }
}

/**
 * POST /api/auth/register
 * Body: { email, password, lastName, firstName, middleInitial?, studentId, department, course }
 * Creates the account, then emails a 6-digit code to verify the address.
 */
app.post(
  '/api/auth/register',
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const lastName = String(req.body?.lastName ?? '').trim();
    const firstName = String(req.body?.firstName ?? '').trim();
    const middleInitial = String(req.body?.middleInitial ?? '').trim().slice(0, 1);
    const studentId = String(req.body?.studentId ?? '').trim();
    const department = String(req.body?.department ?? '').trim();
    const course = String(req.body?.course ?? '').trim();

    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (!lastName) throw new HttpError(400, 'Last name is required.');
    if (!firstName) throw new HttpError(400, 'First name is required.');
    if (!STUDENT_ID_RE.test(studentId)) {
      throw new HttpError(400, 'Enter a valid student ID (6-20 digits or dashes).');
    }
    if (!department) throw new HttpError(400, 'Department is required.');
    if (!course) throw new HttpError(400, 'Course is required.');

    // Fail before creating the auth user, so a duplicate ID cannot orphan an account.
    const { rows: clash } = await pool.query(
      `select 1 from public.profiles where student_id = $1 limit 1`,
      [studentId],
    );
    if (clash.length) {
      throw new HttpError(409, 'That student ID is already registered.');
    }

    const fullName = composeFullName({ lastName, firstName, middleInitial });

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          role: 'student',
          full_name: fullName,
          last_name: lastName,
          first_name: firstName,
          middle_initial: middleInitial,
          student_id: studentId,
          department,
          course,
        },
      },
    });

    if (error) {
      const status = error.status === 429 ? 429 : 400;
      throw new HttpError(status, error.message || 'Could not create the account.');
    }
    if (!data?.user) throw new HttpError(400, 'Could not create the account.');

    // The trigger fills the profile from user metadata; this backfills accounts
    // created before the columns existed and repairs any partial row.
    await pool.query(
      `update public.profiles
          set full_name = $2, last_name = $3, first_name = $4, middle_initial = $5,
              student_id = $6, department = $7, course = $8
        where id = $1`,
      [data.user.id, fullName, lastName, firstName, middleInitial || null,
       studentId, department, course],
    );

    await sendAccessCode(email);

    res.status(201).json({
      ok: true,
      needsVerification: true,
      message: `Account created. We sent a 6-digit code to ${email}.`,
    });
  }),
);

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Unverified accounts get a fresh code instead of a session.
 */
app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');

    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (!password) throw new HttpError(400, 'Enter your password.');

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data?.session) {
      throw new HttpError(401, 'Incorrect email or password.');
    }

    const { rows } = await pool.query(
      `select ${PROFILE_COLUMNS} from public.profiles where id = $1`,
      [data.user.id],
    );
    const profile = rows[0];

    if (!profile?.email_verified_at) {
      await sendAccessCode(email);
      return res.status(403).json({
        ok: false,
        needsVerification: true,
        message: 'Verify your email first. We sent a new 6-digit code.',
      });
    }

    res.json({
      ok: true,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
      profile,
    });
  }),
);

/**
 * POST /api/auth/send-code
 * Body: { email } - resends the verification code.
 */
app.post(
  '/api/auth/send-code',
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');

    await sendAccessCode(email);
    res.json({ ok: true, message: `Access code sent to ${email}.` });
  }),
);

/**
 * POST /api/auth/verify-code
 * Body: { email, code }
 * Marks the address verified and returns a session.
 */
app.post(
  '/api/auth/verify-code',
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const code = String(req.body?.code ?? '').trim();

    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (!CODE_RE.test(code)) throw new HttpError(400, 'The access code must be 6 digits.');

    const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
    if (error || !data?.session) {
      throw new HttpError(401, error?.message || 'That access code is invalid or has expired.');
    }

    const { rows } = await pool.query(
      `insert into public.profiles (id, email, full_name, email_verified_at)
            values ($1, $2, $3, now())
       on conflict (id) do update
              set email = excluded.email,
                  full_name = coalesce(public.profiles.full_name, excluded.full_name),
                  email_verified_at = coalesce(public.profiles.email_verified_at, now())
         returning ${PROFILE_COLUMNS}`,
      [data.user.id, data.user.email, data.user.user_metadata?.full_name ?? email.split('@')[0]],
    );

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
 * GET /api/consultations/next
 * The soonest scheduled consultation: advisers see the ones they advise,
 * students see the ones booked for their thesis group.
 */
app.get(
  '/api/consultations/next',
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
        limit 1`,
      [id, role, groupName],
    );

    res.json({ consultation: rows[0] ?? null });
  }),
);

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

    // An adviser booking for themselves is the default; a student may name an adviser.
    const adviserId =
      req.body?.adviser_id ?? (req.profile.role === 'adviser' ? req.profile.id : null);

    const { rows } = await pool.query(
      `insert into public.consultations
              (adviser_id, group_name, topic, location, meeting_date, status, created_by)
       values ($1, $2, $3, $4, $5, 'scheduled', $6)
    returning id, adviser_id, group_name, topic, location, meeting_date, status, created_at`,
      [adviserId, groupName, topic, location, meetingDate.toISOString(), req.profile.id],
    );

    res.status(201).json({ consultation: rows[0] });
  }),
);

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
