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
  src/components/ConsultationThread.jsx    per-consultation chat
  src/components/CompleteSessionModal.jsx  minutes + action items
  src/components/HistoryView.jsx           sessions already held
  src/components/RecordView.jsx            the printable consultation record
  src/components/ProposeTimeModal.jsx      counter-offer / move a session
  src/components/SlotPicker.jsx            shared slot grid
  src/lib/api.js           fetch wrapper
  src/lib/session.js       localStorage session
  src/lib/schedule.js      weekday / slot helpers
  src/lib/milestones.js    the capstone sequence, shared by the tracker and wrap-up
  src/components/GroupView.jsx         create / join / manage a thesis group
  src/components/CalendarView.jsx      the adviser's week
  src/components/CoordinatorView.jsx   groups, advisers and milestones, program-wide
supabase/migrations/
  0001_init.sql            schema, RLS, auth trigger
  0002_restrict_function_grants.sql
  ...
  0006_adviser_availability.sql        consultation hours
  0007_messages_and_session_wrapup.sql threads, minutes, action items
  0008_attendance.sql                  who was in the room
  0009_counter_proposals.sql           counter-offers, moves, cancellation
  0010_group_milestones.sql            capstone progress, per thesis group
  0011_consultation_attachments.sql    booking attachments + private bucket
  0012_thesis_groups.sql               sections, real groups with members
  0013_program_level.sql               coordinators, adviser assignment, configurable
                                       milestones, panels, submissions, feedback
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

## Who this server will email

`hau.edu.ph` is a real domain with real staff behind it, and the mock adviser
accounts are seeded with real-looking addresses (`baquino@hau.edu.ph` and 39
others). Two rules keep a live login code out of a stranger's inbox.

**1. `SIGNUP_ALLOWLIST` — the only addresses we will mail at all.** Empty means
sign-up is open to any HAU address, which is fine for a private test and not
fine for anything a stranger can reach: they could make this server send a real
6-digit code to an actual faculty member. Set it before demoing publicly.

```bash
# a whole address, or a domain written with its at-sign
SIGNUP_ALLOWLIST=japangilinan1@student.hau.edu.ph,@student.hau.edu.ph
```

Do not confuse it with `AUTH_EMAIL_ALLOWLIST`, which does the opposite:

| Variable | Effect |
| --- | --- |
| `AUTH_EMAIL_ALLOWLIST` | **Widens** — non-HAU addresses that may register |
| `SIGNUP_ALLOWLIST` | **Narrows** — the only addresses we will email |

**2. `/api/auth/send-code` is a resend, not a send.** It used to mail any
well-formed HAU address on request, creating the account on the way — an open
relay pointed at a university's domain. It now requires a half-finished sign-up
to resend for, and passes `createUser: false`, so it cannot conscript an address
that has no account:

| Address | Result |
| --- | --- |
| A half-finished sign-up | code resent |
| Any of the 40 seeded advisers | `409` — already registered, nothing sent |
| A real HAU address that never signed up | `404` — nothing sent |

The seeded advisers are additionally protected on `/api/auth/start`, which
refuses any address whose registration is already complete — and all 40 are,
since the adviser directory only lists completed registrations.

> The mock accounts were created with their emails pre-confirmed, so Supabase
> never mailed them: `confirmation_sent_at` is null on all 40.

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
| POST | `/api/consultations/:id/propose` | Bearer | Offer a different time |
| PATCH | `/api/consultations/:id/proposal` | Bearer | Accept or refuse that offer |
| PATCH | `/api/consultations/:id/cancel` | Bearer | Call it off, with a reason |
| GET | `/api/consultations/history` | Bearer | Sessions already held |
| GET | `/api/consultations/:id` | Bearer | One session + who a task can go to |
| GET | `/api/consultations/:id/messages` | Bearer | The thread (also marks it read) |
| POST | `/api/consultations/:id/messages` | Bearer | Send a message |
| GET | `/api/messages/unread` | Bearer | Unread totals for the badges |
| POST | `/api/consultations/:id/complete` | Bearer | Wrap up: minutes, attendance, action items |
| GET | `/api/groups` | Bearer | Groups you can pull a record for |
| GET | `/api/record?group=` | Bearer | The full consultation record |
| POST | `/api/consultations/:id/tasks` | Bearer | Raise one more action item |
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

### When the time does not work

A group asks for 9-11am; the adviser teaches then and wants noon. Approve and
decline were the only two answers available, so the real one came out as a
sentence in `decline_reason` and the group had to start over and guess again.

The adviser can now **offer another time**, picked from their own published
hours so the offer is guaranteed to be one they are free for. The group still
has to accept it:

```
student requests 9-11am        status: pending      -> adviser's move
   |
   +- approve             -> scheduled
   +- decline             -> declined  (reason, thread stays open)
   +- offer noon instead  -> pending + proposed_date  -> STUDENT's move
                                |
                                +- accept   -> scheduled at noon
                                +- can't    -> cancelled; book another slot
```

**Why the group still has to agree.** They asked for 9am because that is when
they are free; noon is very likely a class. Booking it for them does not produce
a meeting, it produces a no-show — which wastes the adviser's slot *and* lands in
the consultation record as a session that never happened.

**Why it is not a negotiation.** The adviser's time is the scarce resource, so
this is one counter-offer, then accept or start over. Refusing a counter-offer
closes the request rather than bouncing it back; there is no ping-pong.

Three things make it hold together:

- **`meeting_date` never moves until somebody accepts.** The offer lives in
  `proposed_date`, so a proposal can never quietly relocate a session nobody
  agreed to move. Accepting is the only thing that writes `meeting_date`.
- **A live offer holds its slot.** The slot grid and the booking guard both look
  for `proposed_date` as readily as `meeting_date`, so another group cannot take
  noon while the first group is sitting in the class that caused the problem.
- **An offer expires on its own.** It counts only while `proposed_date > now()`,
  so nothing has to sweep the table and a stale offer stops holding its slot.

Whose move it is, is derived rather than stored — `needs_you` on each row of the
inbox — so an adviser who has already counter-offered stops being nagged about
their own offer.

**Moving and cancelling** are the same machinery. Either side can ask to move an
already-scheduled session (the other side accepts, and refusing leaves the
original time standing), and either side can cancel outright with a reason. That
is what finally makes `cancelled` reachable — it had sat in the status CHECK
since 0005 with nothing able to set it.

### Consultation threads

Every consultation carries a chat thread, opened from the **Messages** button on
a session, a request or a past session, and from the envelope in the header
(which jumps to whichever thread has the most unread).

Threads are scoped to a **consultation**, not to a student/adviser pair. There is
no standing group-to-adviser link in this schema — an adviser is picked per
booking — so a pair has no natural scope or permission rule. A consultation
already carries both sides and its own access rule, the same predicate the
upcoming list, the request inbox and the task list all use, so threads inherit it
unchanged.

This is also the reply channel a decline never had. `decline_reason` is one
sentence with nowhere to answer it, so "I have a class then, try Thursday" ended
the conversation instead of continuing it; a declined request now shows a
**Reply** button and the reason as the first thing in the thread.

Unread is one high-water mark per person per thread (`consultation_reads`) rather
than a read flag per message, since the badge only ever needs "since when". A
message counts as unread when somebody else sent it after you last opened that
thread. Opening a thread marks it read up to the newest message *returned*, not
to `now()`, so a message landing mid-request stays unread rather than being
silently skipped.

**Delivery is polling, every six seconds, while a thread is open.** Supabase
Realtime is the obvious upgrade, but the client has no Supabase wiring at all
today — it only talks to this Express API, which reaches Postgres as the owner,
so RLS is defence in depth rather than the enforcement point. Pushing live
updates into the browser would make RLS load-bearing and is a separate piece of
work. A six-second poll needs neither.

### Completing a session

An adviser wraps up a session from **Wrap up** on the consultation card or in
**Past sessions**: what was agreed, plus the action items that came out of it,
each optionally assigned to one student and given a due date. It runs in one
transaction — a half-written wrap-up, session closed and tasks lost, cannot be
recovered from the UI.

Two things were broken before this existed, and they were the same hole from two
ends:

- **`action_items` had no writer.** Nothing in the API could insert one, so the
  Action items screen, its stat tile and every task card were permanently empty
  for every user. `PATCH /api/tasks/:id` could resolve a row nothing could
  create.
- **A consultation could never finish.** `completed` and `cancelled` were in the
  status CHECK from 0005 but unreachable. A session happened, fell out of the
  `meeting_date >= now()` filter, and was gone — nothing recorded that it took
  place.

Completing sets `completed`, which drops the session out of every "upcoming"
query and into **Past sessions**. A past session nobody wrapped up still appears
there, flagged *Not wrapped up*, because it happened whether or not anyone wrote
it down — surfacing it is how it gets finished.

Action items also gained a real `due_date`. The task card used to show the date
of the session an item came *from* in the slot where a deadline belongs; it now
shows the deadline when there is one, in red once it is past.

### The consultation record

Every capstone program asks a group to hand in a signed log of the consultations
they held. Everything on that form was already in this database — dates, topics,
minutes, action items, and now attendance — and nothing could get it out of the
screen. **Consultation record** is that way out: a printable sheet listing every
session the group has held, in order, with what was agreed, who attended and what
each session left them to do.

Printing is the browser's own print-to-PDF. The sheet is already HTML, a print
stylesheet strips the app shell around it, and a PDF library rendering the same
thing a second way is a second thing to keep in sync. The shell is a fixed-height
flex box with its own scrolling panes, which a printer resolves as "page one and
nothing else", so `@media print` in `index.css` unpicks the height, the overflow
and the chrome, and keeps a session from splitting across a page break.

A student's record is their own group's. An adviser picks from the groups they
advise (`GET /api/groups`) and sees the sessions they advised — the same access
predicate as everywhere else, so a group you have no claim on simply 404s.

There is deliberately **no "record signed" flag**. A completed consultation is
already the adviser's attestation: they wrote the minutes and marked it done. The
sheet cites each session's own `completed_at` and leaves a signature line for the
wet signature these forms get anyway.

### Attendance

Recorded by the adviser during the wrap-up, since that is the only moment anyone
knows the answer. It is **opt-in**: there is a "take attendance" toggle, off by
default, because defaulting everyone to present would record an attestation the
adviser never made. That gives the record three genuinely different states, and
it prints all three differently:

| Stored | Printed |
| --- | --- |
| No rows | *not recorded* |
| `present = true` | listed under Present |
| `present = false` | listed under absent |

Re-running a wrap-up overwrites attendance rather than duplicating it — the
primary key is the (consultation, person) pair.

## Known placeholders

- **Email notifications** are not wired. Requests and thread messages are
  notified inside the app only (the bell, the envelope, the sidebar badge);
  nothing lands in anyone's inbox, and Supabase Auth only sends the sign-in code.
  This matters more now that there are threads — a message sits unseen until the
  other side next opens the app. Add a mailer if it needs to reach someone who is
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
- **`group_name` is free text**, matched between `profiles` and `consultations`
  by string equality. "Group 7 - BSIT" and "Group 7 – BSIT" are silently two
  different groups, and a student whose profile does not match character for
  character sees none of their group's sessions. A `groups` table with a real id
  is the fix.
- **Sessions expire abruptly.** `refresh_token` is saved to localStorage but only
  ever used during registration — never to refresh an expiring session, so a
  student is dropped to the login screen mid-task.
- **No reminders.** Nothing tells either side that a consultation is tomorrow,
  which is the usual reason one gets missed. Needs the mailer above.
