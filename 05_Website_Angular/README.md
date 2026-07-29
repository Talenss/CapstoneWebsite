# ResumeMatch PH — Angular + Node edition

A free résumé builder + transparent, rule-based job-matching platform for
Filipino job seekers, piloted with **Royce Hotel & Casino** (Clark Freeport
Zone). This folder (`05_Website_Angular`) is the current app — an **Angular 21**
front end + **Node/Express (TypeScript)** back end on a **Supabase / PostgreSQL**
database. `../04_Website` is the old PHP version, kept only as a reference;
**this folder needs nothing from it.**

> This README is the "start here". For the full server / Supabase / email / AI
> setup and the going-live checklist, see **[SETUP.md](./SETUP.md)**.

---

## What's in the app right now

**For job seekers**
- Guided résumé wizard with live preview, plus "upload & analyze" (AI reads a
  file into the builder; scoring stays with the rule-based engine).
- **8 ATS-safe résumé designs** to choose from (Classic, Modern, Minimal,
  Executive, Banner, Split, Bar, Categorized) — single-column, parser-safe,
  applied to the on-screen preview and the printed / PDF export.
- Honest match scores against every real opening (**skills 50 / education 25 /
  experience 25**, weights published), in three tiers — strong, possible,
  related. No one is auto-rejected.
- Save openings, track applications through all five statuses, job alerts.
- **Application history** — every application keeps a dated record of each
  status it has held, and the applicant can read it: when they applied, when a
  recruiter moved it, and how long each step took. Attributed to the employer,
  never to a named individual.

**For recruiters / HR**
- Applications arrive scored and ranked with the maths shown; both résumés
  (structured + uploaded file) side by side; message an applicant by email.
- **Department-based routing:** a new application's email goes to the HR person
  who owns that posting's department; unowned departments notify all recruiters.
- **"Who has handled this"** — opening an applicant shows the recorded trail of
  every status change with the **name of the colleague** who made it and how
  long the applicant has been waiting since. Several HR people share one pool
  once departments are routed, so the current status alone does not say whether
  someone acted an hour ago or three weeks ago. The applicant's own view of the
  same record never names an individual — internal accountability and applicant
  transparency are different disclosures, and the server decides which is which.

**For the research team (admin)**
- Recruiter-access approval, department-routing assignment, and anonymous
  **study metrics** with JSON export.

**Site-wide**
- Royce-branded **HR-SaaS UI** (Fraunces + Manrope + JetBrains Mono, lion crest).
- **Light / dark mode** — a toggle in the header, applied on every page, saved
  to the browser, and respecting your OS preference on first visit.
- Fully responsive (works down to 390 px), onboarding tour, email verification,
  password reset, security hardening.

---

## Quick start — demo mode (zero setup)

No database, no internet, no keys. Runs entirely in the browser (localStorage).

```bash
cd 05_Website_Angular/client
npm install
npm start
```

Open <http://localhost:4200>. Sign in with any of these (password `demo123`):

| Role | Email |
|---|---|
| Job seeker | `seeker@demo.ph` |
| Recruiter (Royce HR) | `hr@demo.ph` |
| Admin (research team) | `admin@demo.ph` |

To wipe demo data: open the browser console → `localStorage.clear()` → refresh.

---

## Full mode — Node API + Supabase (real persistence)

The short version (full details in **[SETUP.md](./SETUP.md)**):

1. **Database:** create a free Supabase project → SQL Editor → paste and run
   `db/resumematch_ph.sql` (the whole schema + demo data in one file).
2. **Server:** `cd server && npm install && cp .env.example .env`, then set
   `DATABASE_URL` to your Supabase **Session pooler** connection string.
   Start it: `npm run dev` (listens on `http://localhost:4300`).
3. **Client:** in `client/src/environments/environment.ts` set `mode: 'api'`,
   then `cd client && npm start`.

### Environment variables (`server/.env`) — all optional except the database

| Variable | Needed for | If unset |
|---|---|---|
| `DATABASE_URL` | Supabase/Postgres connection | server mode won't run (demo mode still works) |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | verification codes, password reset, notifications | codes print to the server console in `DEBUG` mode |
| `GEMINI_API_KEY` | "upload & analyze" AI extraction | that one feature shows "not configured"; everything else works |
| `SESSION_SECRET`, `DEBUG`, `TRUST_PROXY`, `COOKIE_SECURE`, `APP_URL` | production hardening | sensible dev defaults (see SETUP.md → going-live checklist) |

`db/resumematch_ph.sql` is a full reset (it drops tables first) — don't run it
on a database whose data you want to keep. New tables/columns added over time
are also applied automatically by idempotent migrations on server start.

---

## Handy commands

```bash
# client (from client/)
npm start           # dev server on :4200
npm run build       # production build (api mode — talks to the server)
npm run build:demo  # browser-only build (demo mode, no server needed)

# server (from server/)
npm run dev         # API on :4300, restarts on change
npm run build && npm start   # production; also serves the built Angular app
npm test            # engine + file-type tests (30, no database needed)
npm run test:api    # API integration tests (35) — needs a local PostgreSQL;
                    # creates and drops its own throwaway database
npm run test:email  # email delivery (10) — real SMTP dialogue, local sink
npm run test:analyze # AI extraction (10) — local stand-in for Gemini
npm run test:parity # demo-mode vs API-mode parity (10) — needs PostgreSQL
npm run test:all    # all 95 server tests
npm run create-admin -- you@example.com "a strong password"
```

## Browser walkthroughs

Unit tests cannot catch a page that renders blank or a button that quietly
stops saving. Five scripts drive the real thing.

**Demo mode** (dev server, no database):

```bash
cd client && npm start -- --port 4210      # then, in another terminal:
node ../e2e/demo-walkthrough.mjs    # all three roles, every page, dark mode, 390px
node ../e2e/upload-walkthrough.mjs  # the own-file upload, its limits, and the AI disclosure
node ../e2e/a11y-walkthrough.mjs    # modal focus traps and score attribution
node ../e2e/anchors-walkthrough.mjs # in-page links: learning-hub guides, skip link
```

Run the first one on the morning of a demo. If it reports 17/17, the demo works.

**API mode** (production bundle, real server, real PostgreSQL):

```bash
cd client && npm run build
cd ../server && npm run build && node dist/server.js   # then, in another terminal:
node ../e2e/api-walkthrough.mjs
```

Run this one before deploying. It is the only check that sees the **production
build** and the server's Content-Security-Policy together — the combination that
once shipped a site rendering on critical CSS alone, with every button an
unstyled browser default, while all the demo-mode checks stayed green.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:
it builds the Angular client, type-checks the server, runs the engine tests,
and runs the API integration tests against a throwaway PostgreSQL service. No
secrets are needed, so CI goes green out of the box.

## The one switch that matters

`client/src/environments/environment.ts` → `mode: 'demo' | 'api'`. Demo runs in
the browser; `api` talks to the Node server. Nothing else changes between them.

But they are **not two builds of the same code**: demo mode is a separate
hand-written implementation (`client/src/app/core/demo-adapter.ts`). Demo mode is
what gets demonstrated; api mode is what a real applicant would use. A rule
enforced in one and not the other would make the demonstration a
misrepresentation of the system, so `npm run test:parity` drives the same
operations through both and asserts they agree — on the guards, on the
validation, and on the actual scores.

## A note on `demo123`

The seeded accounts use a seven-character password while the app's rule asks for
eight with a letter and a number. That is deliberate, not an oversight: the rule
is enforced wherever a password is **set** (register, reset, change) and never at
login, so a policy change can never lock an existing user out of their own data.
The seed rows insert a bcrypt hash directly and so bypass the rule by
construction. The practical consequence: you cannot change one of these
passwords *back* to `demo123` through the UI.
