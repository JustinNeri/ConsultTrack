# ConsultTrack — Gmail OTP setup and Vercel deployment

Two guides. Do Part A first: if the access code never arrives, nothing else matters.

---

# Part A — Gmail verification (Supabase Auth + Gmail SMTP)

## A1. Create a Gmail App Password

A normal Gmail password will not work for SMTP. You need a 16-character App
Password, and that requires 2-Step Verification.

1. Go to <https://myaccount.google.com/security>
2. Turn on **2-Step Verification** if it is off. You cannot skip this — the App
   Passwords page does not exist without it.
3. Go to <https://myaccount.google.com/apppasswords>
4. Type a name (`ConsultTrack Supabase`) and click **Create**.
5. Copy the 16 characters shown, e.g. `abcd efgh ijkl mnop`.
   **Remove the spaces** → `abcdefghijklmnop`. Google shows it once.

> Google Workspace / school accounts: an admin may have App Passwords disabled.
> If <https://myaccount.google.com/apppasswords> shows nothing, use a personal
> Gmail for the sender, or ask the admin to allow it.

## A2. Point Supabase at Gmail SMTP

Supabase Dashboard → project **ConsultTrack** → **Project Settings** →
**Authentication** → **SMTP Settings** → enable **Custom SMTP**:

| Field | Value |
| --- | --- |
| Sender email | your full Gmail address |
| Sender name | `ConsultTrack` |
| Host | `smtp.gmail.com` |
| Port | `587` |
| Username | the same full Gmail address |
| Password | the 16-character App Password, no spaces |
| Minimum interval between emails | `10` seconds (see A5) |

Save.

> Port 587 uses STARTTLS, which is what Supabase expects. If your host blocks
> 587, port 465 also works.

## A3. Make the email send a CODE, not a link — this is the step people miss

By default Supabase emails a magic **link**. Your `AuthScreen` asks for six
digits, so if you skip this the user gets a clickable link and the code screen
has nothing to type.

**Authentication** → **Emails** → **Magic Link** template. Replace the body with
something that prints `{{ .Token }}`:

```html
<h2>Your ConsultTrack access code</h2>
<p>Use this code to sign in:</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:24px 0">
  {{ .Token }}
</p>
<p style="color:#64748b">This code expires in 10 minutes. If you did not request
it, you can ignore this email.</p>
```

Key point: `{{ .Token }}` is the 6-digit code. `{{ .ConfirmationURL }}` is the
magic link. Remove the URL entirely so nobody clicks it instead.

Set the subject to something like `Your ConsultTrack access code`.

## A4. Confirm the email provider is on

**Authentication** → **Sign In / Providers** → **Email**:

- **Enable Email provider** — on
- **Confirm email** — on is fine; OTP sign-in confirms the address by itself
- Leaving passwords enabled is harmless; the app never uses them

## A5. Rate limits

**Authentication** → **Rate Limits**:

- *Rate limit for sending emails* — default is 2 per hour on the built-in SMTP.
  With custom SMTP you can raise it. For a class demo, 30–60/hour is sane.
- The `AuthScreen` resend button already enforces a 60-second cooldown client
  side; the "minimum interval" in A2 enforces it server side.

**Gmail's own ceiling is roughly 500 messages per day** and it is not adjustable.
Fine for a capstone. Move to Resend / SendGrid / Postmark before a real launch.

---

## A6. Who is allowed to sign up

Registration is limited to HAU Google Workspace accounts, and the domain also
decides the account type:

| Address | Role |
| --- | --- |
| `@student.hau.edu.ph` | student |
| `@hau.edu.ph` | adviser (faculty) |

Both live in `HAU_DOMAINS` / `roleForEmail()` in `server/app.js`. The domain check
runs on `/auth/start`, `/auth/send-code` and `/auth/verify-code`, and the role is
stamped on the profile when the code is verified — the sign-up form cannot ask for
a role, so a student cannot register as an adviser. Sign-in only checks that the
address is well formed, so an account created before this rule was added still
works.

Advisers use the same three-step sign-up as students; step 3 asks them for a
faculty ID and academic position instead of a student ID, course and year level.

Delivery to those addresses is ordinary Gmail → Google Workspace mail and needs
no extra setup. If a code does not arrive, check spam first, then Supabase →
**Logs** → **Auth Logs** for an SMTP failure.

To demo with a personal address, set `AUTH_EMAIL_ALLOWLIST` on the API to a
comma-separated list:

```
AUTH_EMAIL_ALLOWLIST=you@gmail.com,panelist@gmail.com
```

Those addresses skip the domain check and nothing else. Leave the variable
unset in production.

## A6. Test it end to end

```bash
cd server
cp .env.example .env      # fill SUPABASE_ANON_KEY + DATABASE_URL
npm install && npm run dev
```

```bash
curl -X POST http://localhost:4000/api/auth/send-code \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"you@gmail.com\"}"
```

Expected: `{"ok":true,"message":"Access code sent to you@gmail.com."}` and a
6-digit code in your inbox within ~30 seconds.

Then verify:

```bash
curl -X POST http://localhost:4000/api/auth/verify-code \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"you@gmail.com\",\"code\":\"123456\"}"
```

Expected: an `access_token` and your `profile`.

## A7. Set your role and thesis group

The signup trigger creates the profile with `role = 'student'` and a null group.
The dashboard filters by group, so set it once per user — SQL Editor:

```sql
update public.profiles
   set full_name  = 'Juan Dela Cruz',
       role       = 'student',
       group_name = 'Group 7 - BSIT'
 where email = 'you@gmail.com';
```

For an adviser: `set role = 'adviser'` (advisers are matched by `adviser_id`, so
they do not need a `group_name`).

## A8. When the code does not arrive

| Symptom | Cause |
| --- | --- |
| `Error sending confirmation email` | App Password wrong, or spaces not stripped |
| Email arrives with a link, not digits | A3 not done — template still uses `{{ .ConfirmationURL }}` |
| `email rate limit exceeded` | A5, or you are resending too fast |
| Nothing at all, no error | Check spam; then **Logs** → **Auth Logs** in the dashboard |
| `Invalid login: 535` in auth logs | 2FA off, or you used the account password instead of the App Password |

---

# Part B — Deploying to Vercel

The repo is already set up for a **single Vercel project** that serves the React
build as static files and the Express app as one serverless function:

```
api/index.js      re-exports the Express app  ->  handles /api/*
vercel.json       rewrites, build command, output directory
package.json      root deps that the serverless function needs
client/dist       static output
```

`server/server.js` still runs the identical app locally — nothing about your dev
loop changes.

## B1. Push to GitHub

You are committing, so: create the repo, commit, push. Vercel deploys from a git
remote.

## B2. Import into Vercel

1. <https://vercel.com/new> → **Import Git Repository** → pick ConsultTrack
2. **Framework Preset:** `Vite`
3. **Root Directory:** leave as the repo root — *not* `client`. The root is where
   `vercel.json` and `api/` live.
4. Do not override Build Command or Output Directory. `vercel.json` sets them:
   - install: `npm install && npm install --prefix client`
   - build: `npm run build --prefix client`
   - output: `client/dist`

## B3. Environment variables

**Settings** → **Environment Variables**, applied to Production *and* Preview:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | `https://xruquzbkwuuziujuivrg.supabase.co` |
| `SUPABASE_ANON_KEY` | your publishable anon key |
| `DATABASE_URL` | **transaction pooler** string, port `6543` (see B4) |
| `PG_POOL_MAX` | `1` |
| `CLIENT_ORIGIN` | your deployed URL, e.g. `https://consulttrack.vercel.app` |
| `AUTH_EMAIL_ALLOWLIST` | leave unset in production (see A6) |

Do **not** set `VITE_API_URL` — the client defaults to `/api`, which is the same
origin in production. That is what you want.

## B4. Use the transaction pooler, not the direct connection

This is the single most common way a Postgres app breaks on serverless. Every
invocation is its own container, so direct connections pile up until Supabase
refuses new ones.

Supabase Dashboard → **Connect** → **Transaction pooler**:

```
postgresql://postgres.xruquzbkwuuziujuivrg:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
```

Port **6543**, not 5432. URL-encode special characters in the password
(`@` → `%40`, `#` → `%23`, and so on).

`PG_POOL_MAX=1` keeps each container to one connection, which is the right shape
for transaction pooling.

## B5. Deploy and verify

Click **Deploy**, then check, in this order:

```bash
curl https://YOUR-APP.vercel.app/api/health
# -> {"ok":true,"uptime":...}      proves the function booted AND reached Postgres

curl -X POST https://YOUR-APP.vercel.app/api/auth/send-code \
  -H "Content-Type: application/json" -d "{\"email\":\"you@gmail.com\"}"
# -> {"ok":true,...}               proves Supabase Auth + Gmail SMTP work in prod
```

Then open the site and sign in for real.

> `/api/health` is the useful first probe because it fails differently for each
> problem: a 500 with a config message means a missing env var, a timeout means
> `DATABASE_URL` is wrong or still on port 5432.

## B6. Point Supabase back at the deployed URL

**Authentication** → **URL Configuration**:

- **Site URL:** `https://YOUR-APP.vercel.app`
- **Redirect URLs:** add `https://YOUR-APP.vercel.app/**`

Pure OTP does not redirect, so this matters less than in a magic-link flow — but
set it now so password reset and any future link-based email behaves.

Also update `CLIENT_ORIGIN` (B3) if you only guessed the URL earlier, and
redeploy so the change takes effect.

## B7. Things worth knowing

- **Rewrite behavior.** `vercel.json` sends `/api/*` to `api/index.js`, and
  Express matches on the original path (its routes are declared as
  `/api/auth/send-code`). If you get a 404 from a route that works locally, log
  `req.url` inside the function first — that is the thing to check.
- **Cold starts.** The first request after idle takes a second or two while the
  function boots and opens a Postgres connection. Normal.
- **Logs.** Vercel → your project → **Logs** shows `console.error` output from
  the function. Supabase → **Logs** → **Auth Logs** shows SMTP failures.
- **Preview deployments** share the same database. Either accept that, or point
  Preview env vars at a Supabase branch.

## Alternative: split hosting

If the serverless function gives you trouble, the lower-friction path is to host
the two halves separately:

- **client** → Vercel, root directory `client`, framework Vite, with
  `VITE_API_URL` set to the API's public URL
- **server** → Render / Railway / Fly, which run a long-lived `npm start`. Then
  `DATABASE_URL` can use the session pooler (5432) and `PG_POOL_MAX` can go back
  to 10.

Set `CLIENT_ORIGIN` on the API to the Vercel URL so CORS passes — the app already
reads that variable.
