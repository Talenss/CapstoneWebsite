# ResumeMatch PH — Angular + Node edition — Setup guide

This is the Angular/Node rebuild of the original PHP + vanilla-JS site in
`../04_Website` (kept in the repo as a reference — nothing here touches it).
Same product, same MySQL schema, same matching engine and rules. What changed:

| | Before (`04_Website`) | Now (`05_Website_Angular`) |
|---|---|---|
| Frontend | Plain HTML/CSS/JS, one file per page | Angular 21 (standalone components), one app |
| Backend | PHP 8 + PDO | Node.js + Express + TypeScript (`mysql2`) |
| Database | MySQL (`db/schema.sql`, `db/seed.sql`) | **Same** — reuse `../04_Website/db/*.sql` as-is |

Like the original, there are two modes:

- **Demo mode** — zero setup. The Angular app runs entirely in the browser,
  storing data in `localStorage`. This is the default.
- **Server mode** — the real thing: Angular talking to the Node API, backed
  by MySQL. Use this for real persistence / multiple users.

---

## Part 1 — Demo mode (no setup)

```bash
cd 05_Website_Angular/client
npm install
npm start
```

Open <http://localhost:4200>. Log in with any of (password `demo123` for all):

| Role | Email |
|---|---|
| Job seeker | `seeker@demo.ph` |
| Royce HR (recruiter) | `hr@demo.ph` |
| More applicants | `ana@demo.ph`, `marco@demo.ph`, `liza@demo.ph` |
| Research team (admin) | `admin@demo.ph` — reviews recruiter requests at `/admin` |

Data lives in that browser's `localStorage` only. To wipe it, open the
console and run `localStorage.clear(); sessionStorage.clear();`, then refresh.

---

## Part 2 — Server mode (Node + MySQL)

### Step 1 — Database

Same schema as the PHP version — nothing to change if you already ran it:

```bash
mysql -u root < ../04_Website/db/schema.sql
mysql -u root < ../04_Website/db/seed.sql
```

This creates the `resumematch_ph` database with the demo accounts above
already seeded (same emails/password as demo mode).

### Step 2 — Start the API server

```bash
cd 05_Website_Angular/server
npm install
cp .env.example .env      # edit DB_* if your MySQL isn't the default XAMPP-style root/no-password
npm run dev                # ts-node-dev, restarts on change — or `npm run build && npm start`
```

It listens on **http://localhost:4300** (`PORT` in `.env`). Applicant-uploaded
files are stored in `server/uploads/`, served only through the access-checked
`/api/file` route — never a public URL.

#### The admin account — approving recruiter requests

Recruiter accounts are provisioned, not self-served: the "Request
recruiter access" form creates a pending request, and an **admin**
approves it at `/admin` — approval is what actually creates the verified
recruiter account (the new recruiter then sets their password through
"Forgot password", guided by the approval email).

Admin accounts are deliberately command-line-only:

```bash
cd 05_Website_Angular/server
npm run create-admin -- you@example.com "a strong password"
```

Then log in at `/auth` with that email and you'll land on the admin
panel. (Demo mode already has `admin@demo.ph` / `demo123` seeded.)

The admin account also gets **Study metrics** (`/admin/metrics`):
anonymous aggregates for the paper's evaluation chapter — score
distribution at application time, tier counts (including how often
people apply to below-threshold "related" roles), the status funnel,
and average time to the first recruiter decision — with a one-click
JSON export.

#### The engine test suite

The matching engine — the study's core claim — has an automated test
suite covering the 50/25/25 weights, each component's scoring rules, the
exact tier boundaries (80/50), and a 500-case sweep proving the server
and client implementations agree exactly:

```bash
cd 05_Website_Angular/server
npm test        # no database needed — the tests run the pure engine
```

#### Optional — email sending (`SMTP_*`): verification codes & password reset

Email powers several things in server mode: the 6-digit **verification
code** at sign-up and when **changing your email address** (so every
address on file is a proven, real inbox), the **password-reset code**,
**application notifications** — seekers get an email when a recruiter
moves their application, recruiters when a new applicant arrives —
**job alerts** (when a brand-new posting scores as a possible-or-better
match against a seeker's active resume, the engine emails them), and
**recruiter messages**: the "Message applicant" button on the ranked
list emails the applicant with the recruiter as reply-to, so interview
scheduling continues over normal email. Notifications and alerts are on
by default with an opt-out in *My account*; security codes and recruiter
messages always arrive. Set `APP_URL` in `.env` to your public URL so
the links inside these emails point at the right place.

All of it needs an SMTP service. Two free options:

**Gmail (simplest if you have a Google account):**

1. Turn on 2-Step Verification for the Google account
   (myaccount.google.com → Security).
2. Create an *App password* at <https://myaccount.google.com/apppasswords>
   (choose "Mail"; copy the 16-character password it generates).
3. In `server/.env`:

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=yourgmail@gmail.com
   SMTP_PASS=the 16-character app password
   MAIL_FROM=ResumeMatch PH <yourgmail@gmail.com>
   ```

**Brevo (free tier, ~300 emails/day, no Gmail needed):** sign up at
<https://www.brevo.com>, get your SMTP credentials from *SMTP & API*, and
fill the same variables with `SMTP_HOST=smtp-relay.brevo.com`.

Behavior without SMTP configured:

- **Demo mode** — no email possible in a pure-browser app, so the code is
  shown on screen in a banner clearly labelled *"Demo mode — no real email
  is sent"*. The flow itself (code entry, expiry, attempt limits) is real.
- **Server mode with `DEBUG=true`** — the code is printed to the server
  console and shown in the page, so you can develop without SMTP.
- **Server mode with `DEBUG=false`** — the user is told email isn't
  configured. Set up SMTP before going live.

The `email_codes` table these features use is created automatically the
first time the server starts — an existing database needs no manual change.

#### Optional — AI resume analysis (`GEMINI_API_KEY`)

The "Upload & analyze my resume" feature sends an uploaded resume to
Google's Gemini API, which extracts the details (skills, education,
experience) to prefill the resume builder. The AI only *extracts* — all
scoring and job matching stays with the rule-based 50/25/25 engine.

To enable it in server mode:

1. Get a free API key at <https://aistudio.google.com/apikey> (Google
   account required, free tier is enough — no billing setup needed).
2. Put it in `server/.env`:

   ```
   GEMINI_API_KEY=your-key-here
   GEMINI_MODEL=gemini-2.5-flash   # optional, this is the default
   ```

3. Restart the server.

Without a key, everything else works normally — the upload-and-analyze
page just tells the user the feature isn't configured and points them to
the builder instead. **Demo mode needs no key at all**: it runs a clearly
labelled simulated extraction so the flow can be demonstrated offline.

### Step 3 — Flip the Angular app to API mode

Open `client/src/environments/environment.ts` and change:

```ts
export const environment = {
  production: false,
  mode: 'demo',   // <-- change to 'api'
  apiBase: '/api',
};
```

### Step 4 — Run it

```bash
cd 05_Website_Angular/client
npm start
```

Open <http://localhost:4200>. The dev server proxies `/api/*` to
`localhost:4300` (see `proxy.conf.json`), so the session cookie stays
same-site with no CORS setup needed. Log in with the same demo accounts —
this time it's really MySQL. Create a new job seeker account and you'll see
it as a row in the `users` table.

---

## Part 3 — Production build

```bash
# Build the Angular app (make sure environment.prod.ts has mode: 'api')
cd 05_Website_Angular/client && npm run build

# Build and start the API — it also serves the Angular build from the same
# origin (client/dist/client/browser), so there's one process, one port,
# no CORS, and the session cookie just works.
cd ../server && npm run build && npm start
```

Then everything is served from `http://localhost:4300` (or whatever `PORT`
you set).

### Going-live checklist

Before exposing the site publicly, set these in `server/.env`:

| Setting | Value | Why |
|---|---|---|
| `DEBUG` | `false` | hides SQL/error detail from API responses |
| `SESSION_SECRET` | long random string | signs the session cookie (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `TRUST_PROXY` | `true` | behind an HTTPS proxy: real client IPs reach the rate limiters |
| `COOKIE_SECURE` | `true` | behind HTTPS: session cookie is HTTPS-only |
| `APP_URL` | your public URL | links inside notification emails |

…and put a real HTTPS reverse proxy (nginx, Caddy, or your cloud host's)
in front of the Node process. No code edits needed — it's all `.env`.

Protections that are always on, no configuration required:

- **Security headers** (helmet) including a content-security-policy
  tailored to what the app actually loads.
- **Login rate limiting** — 10 *failed* attempts per 15 minutes per
  client+email; successful logins never count. Code requests and
  register/reset submissions are similarly capped (on top of the
  per-address cooldowns of the email codes themselves).
- **Password policy** — anything that sets a password (register, reset,
  change, `create-admin`) requires at least 8 characters with a letter
  and a number. Existing passwords keep working until changed.
- **No account enumeration** — login answers with the same message and
  the same timing whether the email exists or not, and password-reset
  requests answer identically either way.

---

## What's where

```
05_Website_Angular/
├── client/                       the Angular app
│   └── src/app/
│       ├── core/                 models, the ApiService (demo + http adapters), session, auth guard, matching engine
│       ├── layout/                header/footer, shared across pages
│       ├── shared/tour/           the onboarding-tour service (port of assets/tutorial.js)
│       └── pages/                 one folder per route — index/auth/seeker-dashboard/browse/
│                                   resume-builder/my-resumes/resume-print/hr-dashboard/
│                                   hr-applicants/hr-posting/hr-company/account/learning-hub/privacy/404
└── server/                       the Node/Express API
    └── src/
        ├── lib/engine.ts          the matching engine — port of api/_lib.php rm_score()
        ├── lib/serializers.ts     DB row → JSON shape, same contract as the PHP version
        └── routes/                one file per resource, same actions as api/*.php
```

The one switch that matters: **`client/src/environments/environment.ts`**,
`mode: 'demo' | 'api'` — exactly like `app/assets/api.js`'s `CONFIG.mode` in
the original. Nothing else changes between the two.
