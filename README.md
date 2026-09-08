# ConsultTrack

Academic consultation scheduling for college thesis groups.

- **Backend** — Node.js, Express, PostgreSQL (Supabase) with parameterized SQL
- **Frontend** — React (Vite), Tailwind CSS v4, Lucide React
- **Auth** — Supabase Auth, email OTP (6-digit access code) over Gmail SMTP

```
server/                    Express API
  app.js                   routes + middleware (exports the app)
  server.js                local entrypoint (app.listen)
api/index.js               Vercel serverless entrypoint -> server/app.js
vercel.json                build config + /api/* rewrite
client/                    Vite + React app
  src/components/AuthScreen.jsx
  src/components/Dashboard.jsx
  src/components/BookingModal.jsx
  src/lib/api.js           fetch wrapper
  src/lib/session.js       localStorage session
supabase/migrations/
  0001_init.sql            schema, RLS, auth trigger
  0002_restrict_function_grants.sql
```

## 1. Database

**Already applied** to Supabase project `ConsultTrack` (`xruquzbkwuuziujuivrg`).
`profiles`, `consultations`, and `action_items` exist with RLS enabled, plus a
trigger that creates a profile row whenever a user signs up through Supabase Auth.
The migration files are kept for reproducibility.

**One addition to the spec:** `profiles.group_name`. Without it there is no way to
tell which consultations a given student is allowed to see — `consultations` only
carries a `group_name` string, and nothing linked a student to a group. Set it per
student after they first sign in:

```sql
update public.profiles set group_name = 'Group 7 - BSIT', role = 'student'
 where email = 'juan.delacruz@gmail.com';
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full Gmail SMTP and Vercel walkthroughs.

## 2. Supabase Auth settings

The OTP flow only sends a **6-digit code** if the email template says so. In
**Authentication → Emails → Magic Link**, the template body must use `{{ .Token }}`
(not `{{ .ConfirmationURL }}`):

```html
<h2>Your ConsultTrack access code</h2>
<p style="font-size:28px;letter-spacing:6px"><strong>{{ .Token }}</strong></p>
<p>This code expires in 10 minutes.</p>
```

Also confirm under **Authentication → Sign In / Providers → Email**: email provider
enabled, and your Gmail SMTP (smtp.gmail.com:587, TLS, app password) saved under
**Project Settings → Authentication → SMTP Settings**.

> Gmail SMTP allows roughly 500 messages/day. Fine for a capstone; move to a
> transactional provider before real deployment.

## 3. Run it

```bash
# terminal 1
cd server
cp .env.example .env      # fill in SUPABASE_ANON_KEY and DATABASE_URL
npm install
npm run dev               # http://localhost:4000

# terminal 2
cd client
npm install
npm run dev               # http://localhost:5173
```

Vite proxies `/api` to `localhost:4000`, so the browser stays on one origin in
development and no CORS round trip is needed.

## API

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/send-code` | — | Email a 6-digit code (`signInWithOtp`) |
| POST | `/api/auth/verify-code` | — | Verify the code (`verifyOtp`), return session |
| GET | `/api/me` | Bearer | Current profile |
| GET | `/api/consultations/next` | Bearer | Soonest scheduled consultation |
| GET | `/api/tasks/pending` | Bearer | Open action items |
| POST | `/api/consultations` | Bearer | Create a booking |
| PATCH | `/api/tasks/:id` | Bearer | Resolve / reopen a task |
| GET | `/api/health` | — | Liveness + DB check |

`PATCH /api/tasks/:id` is not in the original spec — the dashboard's checkable task
cards need something to write to.

## Known placeholders

- **Attachments** in the booking modal are UI only. Files are listed but not
  uploaded; wire them to a Supabase Storage bucket when you need them.
- **Capstone milestones** (`MILESTONES` / `COMPLETED_MILESTONES` in `Dashboard.jsx`)
  are hard-coded, since no table tracks them. The 60% / "System Review" figures come
  from there.
- **Adviser assignment** — a student booking a consultation leaves `adviser_id` null
  unless the request names one. Add an adviser picker, or an `adviser_id` column on
  `profiles`, when you decide how groups are paired with advisers.
