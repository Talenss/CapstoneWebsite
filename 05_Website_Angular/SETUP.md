# ResumeMatch PH — Angular + Node edition — Setup guide

This is the Angular/Node rebuild of an earlier PHP + vanilla-JS prototype.
That prototype was removed from the repository once the rebuild was
complete — it survives in the git history only, and **nothing here depends
on it**; everything `05_Website_Angular` uses lives here. What changed:

| | Before (PHP prototype) | Now (`05_Website_Angular`) |
|---|---|---|
| Frontend | Plain HTML/CSS/JS, one file per page | Angular 21 (standalone components), one app |
| Backend | PHP 8 + PDO | Node.js + Express + TypeScript (`pg`) |
| Database | MySQL | **Supabase / PostgreSQL** — one file: `db/resumematch_ph.sql` |

There are two modes:

- **Demo mode** — zero setup, no database, no internet. The Angular app runs
  entirely in the browser, storing data in `localStorage`. This is the default,
  and your always-available offline fallback for a demo.
- **Server mode** — the real thing: Angular talking to the Node API, backed
  by a Supabase (PostgreSQL) database. Use this for real persistence /
  multiple users.

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
| Clark Outsourcing HR (recruiter) | `hr@demo.ph` |
| More applicants | `ana@demo.ph`, `marco@demo.ph`, `liza@demo.ph` |
| Research team (admin) | `admin@demo.ph` — reviews recruiter requests at `/admin` |

Data lives in that browser's `localStorage` only. To wipe it, open the
console and run `localStorage.clear(); sessionStorage.clear();`, then refresh.

---

## Part 2 — Server mode (Node + Supabase / PostgreSQL)

### Step 1 — Create the database in Supabase

The whole schema and demo data live in **one file**: `db/resumematch_ph.sql`.

1. Create a free project at <https://supabase.com> (or use your existing one).
2. In the dashboard, open **SQL Editor → New query**.
3. Open `db/resumematch_ph.sql`, copy its entire contents into the editor,
   and press **Run**.

That creates every table the Node server uses — including the newer ones
(email codes, saved jobs, notification preferences, posting deadlines, the
admin role) — and seeds the demo accounts above (same emails / `demo123`).
You can browse them under **Table Editor**.

> The file begins with `DROP TABLE IF EXISTS …`, so re-running it is a
> clean reset. Don't run it on a database whose data you want to keep.

### Step 2 — Point the server at Supabase

Grab your connection string: **Supabase → Project Settings → Database →
Connection string → "Session pooler"**, and copy the URL (it looks like
`postgresql://postgres.abcxyz:[YOUR-PASSWORD]@aws-0-…pooler.supabase.com:5432/postgres`).
Use the **Session pooler** one (port 5432) — it supports everything the
server does, including transactions.

```bash
cd 05_Website_Angular/server
npm install
cp .env.example .env
```

Then edit `.env` and set one line:

```
DATABASE_URL=postgresql://postgres.abcxyz:YOUR-PASSWORD@aws-0-…pooler.supabase.com:5432/postgres
```

(`DB_SSL` defaults to on whenever `DATABASE_URL` is set, which is what
Supabase needs — nothing else to configure.)

### Step 3 — Start the API server

```bash
npm run dev                # ts-node-dev, restarts on change — or `npm run build && npm start`
```

It listens on **http://localhost:4300** (`PORT` in `.env`) and, on first
boot, runs a few idempotent migrations (a no-op against a fresh
`resumematch_ph.sql`). Applicant-uploaded files are stored in
`server/uploads/`, served only through the access-checked `/api/file`
route — never a public URL.

> **Local PostgreSQL instead of Supabase?** Leave `DATABASE_URL` empty and
> set `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASS` (and
> `DB_SSL=false`) in `.env`. Create the database and import the same file:
> `createdb resumematch_ph && psql -d resumematch_ph -f db/resumematch_ph.sql`.

> **Free-tier note:** Supabase pauses a project after about a week of
> inactivity; it wakes on the next request, so just open the app (or the
> dashboard) a few minutes before a demo.

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

#### Reading an uploaded resume (`RESUME_EXTRACTOR`)

The "Upload & analyze my resume" feature turns an uploaded document into
fields the builder can prefill and the engine can score. There are two
readers, and `RESUME_EXTRACTOR` in `server/.env` chooses between them.
Either way the reader only *extracts* — all scoring and job matching stays
with the rule-based 50/25/25 engine.

| `RESUME_EXTRACTOR` | Reader | Needs a key | Document leaves the server |
| --- | --- | --- | --- |
| `rules` | `lib/parse-resume.ts` | no | no |
| `gemini` | `lib/extract.ts` | yes | yes, to Google |
| `auto` (default) | `gemini` if a key is set, else `rules` | no | only when a key is set |

**`rules` — pattern matching, no AI.** Section headings, regular
expressions, date arithmetic and a lookup against the same skill
vocabulary the engine scores with. It reads a plain single-column PDF,
`.docx` or `.txt` well. It **cannot** read a scan or a photo, because
there is no text in one to read, and it degrades on multi-column layouts.
Those limits are real and the system reports them to the applicant rather
than returning a confident empty result. Set this to run the whole system
with no AI of any kind and no applicant data leaving the server.

**`gemini` — Google's Gemini API.** Reads images and messy layouts better,
at the cost of sending the applicant's document to a third party.

To use the Gemini reader:

1. Get a free API key at <https://aistudio.google.com/apikey> (Google
   account required, free tier is enough — no billing setup needed).
2. Put it in `server/.env`:

   ```
   RESUME_EXTRACTOR=auto           # or 'gemini' to require it
   GEMINI_API_KEY=your-key-here
   GEMINI_MODEL=gemini-3.5-flash   # optional, this is the default
   ```

3. Restart the server. The key is read from `.env` at boot, so an edit
   while the server is running has no effect until you restart it.

To check it took, open `/upload-resume`. The consent notice is written
from whichever reader is actually configured, so with a working key it
changes to the notice warning that the file is sent to Google. If it
still says the file stays on this server, the key is not being read.

Do not set `GEMINI_MODEL` back to `gemini-2.5-flash`: Google has closed
that model to new API keys and a key created now gets 404 "no longer
available to new users", even though the model still appears in the
`/models` listing.

The free tier is limited to a small number of requests per day, and the
limit is per key, not per person. Plan testing sessions around it — and
note this is exactly why `RESUME_EXTRACTOR` should stay `auto`: when the
quota runs out the rule-based reader answers instead, so the page keeps
working rather than failing in front of a participant.

With `RESUME_EXTRACTOR=gemini` and no key, the upload-and-analyze page
tells the user the feature isn't configured and points them to the
builder; everything else works normally. **Demo mode needs no key and no
server at all**: it runs a clearly labelled simulated extraction so the
flow can be demonstrated offline.

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
this time it's really Supabase. Create a new job seeker account and you'll
see it appear in the `users` table (Supabase → Table Editor).

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

Sessions are stored in Postgres, in a `user_sessions` table the server creates
on first boot — nothing to configure, and no extra service. A restart or a
redeploy therefore does not sign anyone out, and expired rows are swept every
fifteen minutes. Re-importing `db/resumematch_ph.sql` drops that table along
with everything else, because the reset renumbers `user_id` from 1 and an old
cookie must not resolve to whoever now holds that number.

### Uploaded files must go to Supabase Storage

By default an uploaded resume is written to `server/uploads/` on the
machine running Node. That is fine on your laptop and **wrong on a real
host**: Render, Railway and Fly hand the process an ephemeral filesystem,
so every redeploy, restart or sleep gives it a blank disk. The database
rows survive, so the resume stays listed, stays scored and still reaches
the recruiter — while the file behind it has gone.

Set these three and uploads go to Supabase Storage instead, which is
durable and independent of the process:

```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_KEY=your service_role key
SUPABASE_BUCKET=resumes
```

1. Supabase dashboard → **Storage → New bucket**, name it `resumes`.
2. Leave **Public bucket OFF.** Reads are authorised by `routes/file.ts`,
   which checks the caller is the applicant or a recruiter the resume was
   actually sent to. A public bucket would make every resume reachable by
   guessing a URL.
3. **Project Settings → API**, copy the `service_role` key. It bypasses
   row-level security, so it belongs on the server only and must never be
   built into the client bundle.

Leave the three empty and nothing changes — it stays on local disk. No
code path differs; `lib/storage.ts` is the only file that knows which
backend is in use.

…and put a real HTTPS reverse proxy (nginx, Caddy, or your cloud host's)
in front of the Node process. No code edits needed — it's all `.env`.

### Before real people use it: remove the demonstration data

`db/resumematch_ph.sql` seeds seven demonstration accounts that all share
the password `demo123`, and one of them — `admin@demo.ph` — approves
recruiter access. That hash is committed to a public repository, so those
are not credentials, they are published facts. Import the schema and
expose the site without clearing them and anyone can sign in as the
administrator.

```bash
cd 05_Website_Angular/server
npm run go-live            # reports what it would delete; changes nothing
npm run go-live -- --yes   # performs the deletions
```

It removes the `@demo.ph` accounts and everything they own — resumes,
uploaded files, applications — along with the seeded job postings, which
are illustrative openings rather than real vacancies. It keeps the schema,
the 25-skill matching vocabulary, `match_settings`, and the partner
company row so a real recruiter can be attached to it.

Afterwards there is no administrator, deliberately. Create your own:

```bash
npm run create-admin -- you@example.com "a strong password"
```

Then confirm the demonstration login is gone by trying `admin@demo.ph` /
`demo123` on the live site. It must fail.

### Deploying to Render

`render.yaml` at the repository root is a blueprint: it carries the build
and start commands, the health check, and every setting that is not a
secret. Render reads it, so most of this is not typed by hand.

1. <https://render.com> → sign in with GitHub → **New → Blueprint**.
2. Pick this repository. Render finds `render.yaml` and shows one web
   service, `resumematch-ph`.
3. It prompts for the seven secrets the file deliberately does not carry:

   | Prompt | Where it comes from |
   |---|---|
   | `DATABASE_URL` | Supabase → Project Settings → Database → **Session pooler** (port 5432) |
   | `SUPABASE_URL` | Supabase → Project Settings → API |
   | `SUPABASE_SERVICE_KEY` | same page, the **service_role** key |
   | `SMTP_USER` | the Gmail address |
   | `SMTP_PASS` | the 16-character app password, **spaces removed** |
   | `MAIL_FROM` | e.g. `ResumeMatch PH <you@gmail.com>` |
   | `GEMINI_API_KEY` | <https://aistudio.google.com/apikey> |

4. **Apply**. The first build takes a few minutes: it installs and builds
   the client in api mode, then compiles the server.

`SESSION_SECRET` is not in that list on purpose — the blueprint has
`generateValue: true`, so Render generates a random 256-bit value on the
first deploy. Nobody chooses it and no repository has ever seen it.

`APP_URL` is not in that list either. `config.ts` falls back to
`RENDER_EXTERNAL_URL`, which Render sets to the service's own https URL,
so the links inside verification and notification emails are correct
without anyone remembering to set them. Set `APP_URL` by hand only when
a custom domain replaces the `onrender.com` one.

**Then make yourself an admin** — recruiter approvals need one, and admin
accounts are deliberately command-line only. In the Render dashboard open
**Shell**:

```bash
cd 05_Website_Angular/server
npm run create-admin -- you@example.com "a strong password"
```

**About the free plan.** A free web service sleeps after 15 minutes of
inactivity and takes roughly 30–60 seconds to wake, and the plan allows
750 instance-hours a month. That cold start lands in front of the panel
if the site has been idle, so either open it a few minutes beforehand or
move to the cheapest paid instance for the duration of data gathering.
Supabase pauses a free project after about a week idle, and wakes the
same way.

**The demo build is unaffected.** It stays on Vercel, needs no server,
and is the fallback if anything about the live system misbehaves on the
day — see `DEPLOY.md`.


**Set `NODE_ENV=production` too.** With it set, the server checks the three
settings that are dangerous to forget and **refuses to start** if any is
wrong — rather than running with a signing key that is published in this
repository, or with `DEBUG` returning live email verification codes in API
responses. It also flips `DEBUG` off by default. You will see exactly what
is missing:

```
Refusing to start in production with an unsafe configuration:

  · SESSION_SECRET is still the development default — session cookies
    would be forgeable. Set it to a long random string.
  · DEBUG is on in production — it returns email verification codes in
    API responses. Set DEBUG=false.
```

Also build the client with `npm run build` (**not** `build:demo`). The
plain `build` produces the `api`-mode bundle that talks to this server;
`build:demo` produces a browser-only bundle that keeps every visitor's data
in their own `localStorage` and never calls the API at all.

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

## Scoring weights

A score is three checks — skills, education level, months of experience —
and how much each is worth can be set in two places.

**Site defaults** live in the `match_settings` table (`weight_skills`,
`weight_education`, `weight_experience`, as fractions). This is how the
study retunes its published weights without a redeploy; the server
re-reads them at most once a minute and the browser fetches them at
startup, so both sides always score with the same numbers.

**Per opening**, a recruiter can override them on the Post-an-opening
form — `job_postings.weight_skills` / `_education` / `_experience`, stored
as whole percentages. A developer role can lean on skills while a trainee
role leans on education.

Three rules hold this together:

- **All three or none.** An opening with no weights stores `NULL`, not a
  copy of the defaults, so retuning `match_settings` still moves every
  opening that never customised. A partial set is rejected.
- **They must total 100**, and **none may be below 10%**. The floor is
  policy, not arithmetic: a recruiter may decide a criterion matters less
  for a role, but switching one off would score an applicant whose only
  strength is that criterion on a scale that cannot see them. Enforced in
  `routes/postings.ts`, in the demo adapter, and as a `CHECK` constraint
  on the table, so no route into the data can bypass it.
- **The applicant is shown the split.** Whatever an opening uses appears
  on the opening itself and in the dashboard breakdown, because the
  learning hub promises "you see exactly what the recruiter sees" and
  that does not survive a recruiter tuning the score in private.

One consequence, stated on the learning hub too: percentages from two
openings weighted differently are not strictly comparable.

---

## Part 4 — Search engines

Everything below is already in the build. Two things need a decision from
you, and one limit is worth understanding before you judge the results.

### Set `SITE_URL` when you build

```bash
SITE_URL=https://your-domain npm run build:demo
```

This writes `sitemap.xml` and fills in the `Sitemap:` line of
`robots.txt`. Both files need fully-qualified URLs, and a domain is a
deployment fact rather than a source fact, so it comes from the
environment at build time.

**Without `SITE_URL` no sitemap is written at all, and that is
deliberate** — a sitemap listing URLs on the wrong domain is worse than
none, because every URL in it 404s. Four linked pages are found without
one.

Canonical tags and Open Graph URLs do *not* need this: they are taken
from the browser's own origin at runtime, so they are correct on
localhost, on a Vercel preview and on the final domain. Set
`siteUrl` in `environment.ts` only if you need to force one host to be
canonical when the same build is served from several.

### Decide about `publishJobPostings`

`environment.ts` carries `publishJobPostings`, which is **off**. Turning
it on emits schema.org `JobPosting` structured data for every opening —
the markup that puts a listing in the Google Jobs box, and by a wide
margin the highest-leverage thing a job site can publish.

It is off because Google's JobPosting policy requires listings to be
real vacancies that come down when they are filled, and the openings
this build ships with are **seeded demonstration data**. Publishing them
would put jobs that do not exist in front of people in Angeles City who
are actually looking for work, and would expose the site to a manual
action. Turn it on when the postings are real.

The block itself is built and verified — with the flag on, all seven
seeded postings emit valid markup with every field Google requires.

### The limit: this is a client-rendered app

The HTML that arrives from the host is an empty `<app-root>`. The title,
description, canonical, cards and structured data are all written by
JavaScript afterwards, per route, by `client/src/app/core/seo.ts`.

Google renders JavaScript and will see all of it. Most other crawlers,
and most social-media link previewers, will not — they read the fallback
values in `index.html`, which describe the home page. Fixing that
properly means server-side rendering or prerendering the four public
routes, which is a build-system change rather than a settings change.

### What is in the build

| Piece | Where |
|---|---|
| Per-route title, description, canonical, Open Graph, Twitter card | `client/src/app/app.routes.ts` → `core/seo.ts` |
| `noindex` on signed-in pages and the 404 route | `app.routes.ts` |
| WebSite + EducationalOrganization JSON-LD, every page | `core/seo.ts` (`siteJsonLd`) |
| FAQ JSON-LD, learning hub only | `pages/learning-hub/learning-hub.ts` |
| BreadcrumbList | `core/seo.ts` (`breadcrumbs`) |
| JobPosting, gated | `core/seo.ts` (`jobPostings`) |
| `robots.txt` | `client/public/robots.txt` |
| `sitemap.xml` | generated — `client/scripts/make-sitemap.mjs` |
| Social card image | `client/public/og-card.png` |

Check it after any change to the above:

```bash
cd 05_Website_Angular/client
SITE_URL=https://your-domain npm run build:demo
npx http-server dist/client/browser -p 4211 --proxy "http://127.0.0.1:4211?" -s &
node ../e2e/seo-walkthrough.mjs
```

That loads every route in a real browser and fails on a missing or
duplicated description, a missing canonical, a broken card, invalid
JSON-LD, structured data leaking from one page to the next, or a
content-security-policy violation.

### What none of this can do

It cannot make the site rank first. Search ranking is mostly domain
authority, links from other sites, and time — a new domain has none of
the three. What the work above does is make the site *eligible*: every
page describes itself accurately, nothing is blocked or duplicated, and
the local terms someone in Pampanga would actually type are in the
titles and the copy. The national head terms ("resume builder
Philippines", "ATS-friendly resume") are already held by established
sites. The winnable ground is local and specific — Angeles City, Clark
Freeport Zone, BPO — which is what the titles and descriptions target.

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
