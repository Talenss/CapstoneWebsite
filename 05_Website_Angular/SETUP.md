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
you set). Set `DEBUG=false` and a strong random `SESSION_SECRET` in `.env`
before exposing this publicly, and put a real HTTPS reverse proxy in front
of it (and flip the session cookie's `secure: true` in `server/src/server.ts`).

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
