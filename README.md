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
  src/components/BookingModal.jsx      booking form + slot picker
  src/components/AvailabilityView.jsx  the adviser's consultation hours
  src/lib/api.js           fetch wrapper
  src/lib/session.js       localStorage session
  src/lib/schedule.js      weekday / slot helpers
supabase/migrations/
  0001_init.sql            schema, RLS, auth trigger
  0002_restrict_function_grants.sql
  ...
  0006_adviser_availability.sql        consultation hours
```

## 1. Database

**Already applied** to Supabase project `ConsultTrack` (`xruquzbkwuuziujuivrg`).
`profiles`, `consultations`, and `action_items` exist with RLS enabled, plus a
trigger that creates a profile row whenever a user signs up through Supabase Auth.
The migration files are kept for reproducibility.

**One addition to the spec:** `profiles.group_name`. Without it there is no way to
tell which consultations a given student is allowed to see — `consultations` only
carries a `group_name` string, and nothing linked a student to a group. A student
types their group when booking, and that value is what the booking is filed under;
you can also set it on the profile so it prefills:

```sql
update public.profiles set group_name = 'Group 7 - BSIT'
 where email = 'juan.delacruz@student.hau.edu.ph';
```

## Accounts

Two kinds, and the **email domain decides which** — nothing in the sign-up form can
override it:

| Address | Role | Sign-up asks for |
| --- | --- | --- |
| `@student.hau.edu.ph` | `student` | student ID, department, course, year level |
| `@hau.edu.ph` | `adviser` | faculty ID, department, academic position (optional) |

Advisers register through the same three steps as students — email, 6-digit code,
details — at the same URL. There is no separate invite or admin step: a teacher
signs up with their HAU faculty address and lands on an adviser dashboard showing
the sessions booked with them. Once registered they appear in the adviser dropdown
students pick from when booking.

To check who registered as what:

```sql
select email, role, employee_id, department, registration_completed_at
  from public.profiles order by role, email;
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
| GET | `/api/consultations/next` | Bearer | Soonest **approved** consultation |
| GET | `/api/consultations/requests` | Bearer | Requests awaiting a decision |
| GET | `/api/tasks/pending` | Bearer | Open action items |
| GET | `/api/availability` | Bearer | The adviser's own published hours |
| POST | `/api/availability` | Bearer | Publish a weekly block |
| DELETE | `/api/availability/:id` | Bearer | Remove a block |
| GET | `/api/advisers/:id/slots?date=` | Bearer | Open slots on a date, plus `taken` flags |
| POST | `/api/consultations` | Bearer | Book (adviser) / request (student) |
| PATCH | `/api/consultations/:id/decision` | Bearer | Adviser approves or declines |
| PATCH | `/api/tasks/:id` | Bearer | Resolve / reopen a task |
| GET | `/api/health` | — | Liveness + DB check |

`PATCH /api/tasks/:id` is not in the original spec — the dashboard's checkable task
cards need something to write to.

### Consultation approval

A student's booking is a *request*, not a booking. It is created with status
`pending` and appears in the adviser's inbox (`GET /api/consultations/requests`,
surfaced as the bell badge and the "Requests" view). Only when the adviser
approves does it become `scheduled` — and `scheduled` is the status every
"upcoming consultation" query filters on, so an unanswered request can never show
up as an official session. Declining keeps the row as `declined` with the
adviser's reason, which is how the group hears the answer. An adviser booking one
of their own groups is `scheduled` immediately: they are the approver.

Approval is still the adviser's call, but a request booked from published hours
already lands on a time they said they were free, so approving is usually a
formality rather than a negotiation.

Notifications are in-app only (the bell, the sidebar badge and the request list).
Nothing is emailed — see the placeholders below.

### Consultation hours and slot booking

An adviser publishes recurring weekly blocks under **Consultation hours** — say
Wednesdays 1-4 PM in 30-minute slots, in Faculty Room 204. That block becomes six
bookable times every Wednesday.

A student opening the booking form then gets a slot picker instead of a bare time
field: a row of the next dates that adviser actually holds hours on, and the
slots for the chosen day. A slot another group already holds is shown struck out
rather than hidden, so "why can't I get 2 PM" answers itself. Leaving the
location blank fills in the room the block named.

Two rules are enforced server-side in `POST /api/consultations`, not just in the
picker:

1. the time has to sit on a slot boundary inside a published block, and
2. the slot must not already be held by a pending or scheduled session.

The first is skipped for an adviser with no hours on file — they keep the old
free-form booking, so nobody is locked out by a feature they have not set up. It
is also skipped for an adviser booking their own session: consultation hours tell
students when to ask, and an adviser is not asking anyone. The second always
applies, which is what stops two groups landing on the same slot.

Blocks are stored as wall-clock `time` values because a weekly block means the
same campus hour every week, not a fixed UTC instant. `CAMPUS_TIMEZONE`
(default `Asia/Manila`) is what turns a block plus a date into a real timestamp,
and slot times are displayed in that zone rather than the browser's.

Deleting a block does not touch sessions already booked out of it — those are
real consultations now, not slots.

## Known placeholders

- **Email notifications** are not wired. The adviser is notified inside the app
  (bell badge + request list); nothing lands in their inbox. Supabase Auth only
  sends the sign-in code. Add a mailer if requests need to reach advisers who are
  not looking at the dashboard.
- **Attachments** in the booking modal are UI only. Files are listed but not
  uploaded; wire them to a Supabase Storage bucket when you need them.
- **Capstone milestones** (`MILESTONES` / `COMPLETED_MILESTONES` in `Dashboard.jsx`)
  are hard-coded, since no table tracks them. The 60% / "System Review" figures come
  from there.
- **Adviser assignment** — a student picks their adviser per booking, from the
  directory at `GET /api/advisers`, which lists only the advisers in the student's
  own department (`POST /api/consultations` enforces the same rule, so the filter
  is not just cosmetic). There is no standing group-to-adviser link, so
  "Groups booked" on the adviser dashboard counts only groups with an upcoming
  session. Add an `adviser_id` on the group if you want a permanent pairing.
