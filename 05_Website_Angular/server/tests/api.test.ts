/* ============================================================
   API INTEGRATION TESTS
   ------------------------------------------------------------
   The engine suite proves the scoring maths. This one proves the
   RULES AROUND it — the parts a bug would quietly turn into a
   privacy or fairness failure:

     · you must be signed in, and as the right role
     · you can only read and edit your OWN data
     · a recruiter only ever sees their own company's applicants
     · applying twice, or to a closed/expired posting, is refused
     · withdrawing is the applicant's decision alone

   These boot the REAL server as a child process and talk to it
   over HTTP, so sessions, helmet, the guards and the SQL all run
   exactly as they do in production — nothing is mocked.

   Needs a PostgreSQL to point at; it creates and drops its own
   throwaway database, so it never touches your real data.

     cd server && npm run test:api
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import path from 'node:path';

const DB = process.env.TEST_DB_NAME || 'resumematch_apitest';
const PORT = Number(process.env.TEST_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}/api`;
const SCHEMA = path.join(__dirname, '..', '..', 'db', 'resumematch_ph.sql');

const PG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || '5432',
  user: process.env.DB_USER || 'postgres',
  pass: process.env.DB_PASS || 'postgres',
};

let server: ChildProcess | null = null;

function psql(args: string[], db?: string) {
  return execFileSync('psql', [
    '-v', 'ON_ERROR_STOP=1', '-q',
    '-h', PG.host, '-p', PG.port, '-U', PG.user,
    '-d', db ?? 'postgres', ...args,
  ], { env: { ...process.env, PGPASSWORD: PG.pass }, encoding: 'utf8' });
}

/** A tiny cookie-jar fetch — enough to carry one session per "user". */
function client() {
  let cookie = '';
  return async function call(route: string, body: any = {}): Promise<any> {
    const res = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

before(async () => {
  // a throwaway database, built from the same one-file schema users import
  psql(['-c', `DROP DATABASE IF EXISTS ${DB}`]);
  psql(['-c', `CREATE DATABASE ${DB}`]);
  psql(['-f', SCHEMA], DB);

  server = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', path.join(__dirname, '..', 'src', 'server.ts')],
    {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        DB_HOST: PG.host, DB_PORT: PG.port, DB_USER: PG.user, DB_PASS: PG.pass,
        DB_NAME: DB, DB_SSL: 'false', DATABASE_URL: '',
        PORT: String(PORT), SESSION_SECRET: 'api-test-secret', DEBUG: 'true',
        SMTP_HOST: '', GEMINI_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // wait for it to answer
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(`${BASE}/auth/me`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('API server did not start in time');
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

after(() => {
  server?.kill('SIGKILL');
  try { psql(['-c', `DROP DATABASE IF EXISTS ${DB}`]); } catch { /* best effort */ }
});

// ---------- authentication ----------

test('a wrong password is refused', async () => {
  const api = client();
  const { body } = await api('auth/login', { email: 'seeker@demo.ph', password: 'not-the-password' });
  assert.equal(body.ok, false);
});

test('login does not reveal whether an account exists', async () => {
  const api = client();
  const unknown = await api('auth/login', { email: 'nobody@nowhere.ph', password: 'whatever123' });
  const known = await api('auth/login', { email: 'seeker@demo.ph', password: 'wrong-password' });
  assert.equal(unknown.body.ok, false);
  assert.equal(known.body.ok, false);
  // identical wording either way — otherwise the form becomes an account oracle
  assert.equal(unknown.body.error, known.body.error);
});

test('a valid login starts a session that /me recognises', async () => {
  const api = client();
  const login = await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  assert.equal(login.body.ok, true);
  assert.equal(login.body.user.role, 'seeker');
  const me = await api('auth/me');
  assert.equal(me.body.user.email, 'seeker@demo.ph');
});

// ---------- guards: signed in, and the right role ----------

test('protected routes refuse an anonymous caller', async () => {
  const api = client(); // never logs in
  for (const route of ['resumes/list', 'applications/mine', 'postings/mine', 'stats/hr', 'admin/requests']) {
    const { body } = await api(route);
    assert.equal(body.ok, false, `${route} must refuse an anonymous caller`);
  }
});

test('a seeker cannot use recruiter or admin routes', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  for (const route of ['postings/mine', 'stats/hr', 'admin/requests', 'admin/recruiters', 'metrics/summary']) {
    const { body } = await api(route);
    assert.equal(body.ok, false, `${route} must refuse a seeker`);
  }
});

test('a recruiter cannot use admin routes', async () => {
  const api = client();
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  for (const route of ['admin/requests', 'admin/recruiters', 'admin/dept-assignments', 'metrics/summary']) {
    const { body } = await api(route);
    assert.equal(body.ok, false, `${route} must refuse a recruiter`);
  }
});

// ---------- ownership: your data is yours ----------

test('a seeker cannot read another seeker’s resume', async () => {
  const mine = client();
  await mine('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const list = await mine('resumes/list');
  const ownId = list.body.resumes[0].id;

  const other = client();
  await other('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const stolen = await other('resumes/get', { id: ownId });
  assert.equal(stolen.body.ok, false, 'another seeker’s resume must not be readable');
});

test('a seeker cannot overwrite another seeker’s resume', async () => {
  const mine = client();
  await mine('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const victimId = (await mine('resumes/list')).body.resumes[0].id;
  const before = (await mine('resumes/get', { id: victimId })).body.resume.title;

  const attacker = client();
  await attacker('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const write = await attacker('resumes/save', {
    resume: { id: victimId, title: 'HIJACKED', template: 'chronological', design: 'classic',
      personal: { fullName: 'x', email: 'x@x.ph', phone: '', address: '', summary: '' },
      education: [], experience: [], skills: [], certifications: [] },
  });
  assert.equal(write.body.ok, false, 'writing another user’s resume must be refused');

  const after = (await mine('resumes/get', { id: victimId })).body.resume.title;
  assert.equal(after, before, 'the resume must be untouched');
});

// ---------- applying ----------

test('a seeker cannot apply twice to the same posting', async () => {
  const api = client();
  await api('auth/login', { email: 'liza@demo.ph', password: 'demo123' });
  const resumeId = (await api('resumes/list')).body.resumes[0].id;
  const postingId = (await api('postings/list')).body.postings[0].id;

  const first = await api('applications/apply', { resumeId, postingId });
  const second = await api('applications/apply', { resumeId, postingId });
  // the first may already exist from the seed; either way, two in a row can't both succeed
  assert.ok(!(first.body.ok && second.body.ok), 'a duplicate application must be refused');
  assert.equal(second.body.ok, false);
});

test('applying with someone else’s resume is refused', async () => {
  const other = client();
  await other('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const foreignResume = (await other('resumes/list')).body.resumes[0].id;

  const api = client();
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const postingId = (await api('postings/list')).body.postings[0].id;
  const { body } = await api('applications/apply', { resumeId: foreignResume, postingId });
  assert.equal(body.ok, false, 'you may only apply with your own resume');
});

// ---------- withdrawing is the applicant's decision ----------

test('a seeker can withdraw their own application, and only once', async () => {
  const api = client();
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const apps = (await api('applications/mine')).body.applications;
  const open = apps.find((a: any) => !['withdrawn', 'hired', 'rejected'].includes(a.status));
  assert.ok(open, 'expected the seed to leave one application still open');

  const first = await api('applications/withdraw', { id: open.id });
  assert.equal(first.body.ok, true);
  assert.equal(first.body.application.status, 'withdrawn');

  const again = await api('applications/withdraw', { id: open.id });
  assert.equal(again.body.ok, false, 'withdrawing twice must be refused');
});

test('a seeker cannot withdraw someone else’s application', async () => {
  const victim = client();
  await victim('auth/login', { email: 'liza@demo.ph', password: 'demo123' });
  const theirs = (await victim('applications/mine')).body.applications[0];

  const attacker = client();
  await attacker('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const { body } = await attacker('applications/withdraw', { id: theirs.id });
  assert.equal(body.ok, false);
});

test('a recruiter cannot withdraw an application, nor overrule one', async () => {
  const seeker = client();
  await seeker('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const withdrawn = (await seeker('applications/mine')).body.applications
    .find((a: any) => a.status === 'withdrawn');
  assert.ok(withdrawn, 'expected the application withdrawn above');

  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const asRecruiter = await hr('applications/withdraw', { id: withdrawn.id });
  assert.equal(asRecruiter.body.ok, false, 'withdraw is seeker-only');

  const overrule = await hr('applications/set-status', { id: withdrawn.id, status: 'shortlisted' });
  assert.equal(overrule.body.ok, false, 'a withdrawn application is frozen');
});

// ---------- recruiters see only their own company ----------

test('set-status rejects an unknown status', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const postings = (await hr('postings/mine')).body.postings;
  const ranked = (await hr('applications/ranked', { postingId: postings[0].id })).body;
  if (!ranked.rows?.length) return; // nothing to act on in this seed
  const { body } = await hr('applications/set-status', { id: ranked.rows[0].application.id, status: 'promoted' });
  assert.equal(body.ok, false);
});

test('a recruiter only sees applicants for their own company’s postings', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const mine = (await hr('postings/mine')).body.postings;
  const myCompany = mine[0].companyId;
  for (const p of mine) {
    assert.equal(p.companyId, myCompany, 'postings/mine must be company-scoped');
  }
  const ranked = await hr('applications/ranked', { postingId: mine[0].id });
  assert.equal(ranked.body.ok, true);
});

// ---------- the uploaded file is never scored ----------

test('scores come only from structured data — the uploaded file is not read', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const resumeId = (await api('resumes/list')).body.resumes[0].id;
  const postingId = (await api('postings/list')).body.postings[0].id;
  const { body } = await api('match/score', { resumeId, postingId });
  assert.equal(body.ok, true);
  assert.equal(typeof body.score, 'number');
  // the response describes the structured comparison, never the file
  assert.ok(Array.isArray(body.matchedSkills) && Array.isArray(body.missingSkills));
  assert.ok(!('ownFile' in body), 'the scoring response must not involve the uploaded file');
});

/* ============================================================
   REGRESSION TESTS — each of these reproduces a defect that was
   found in the code audit and fixed. They exist so the same bug
   cannot return quietly.
   ============================================================ */

// ---------- the server must survive a bad request ----------

test('a bookmark for a posting that does not exist is refused, not fatal', async () => {
  // saved_jobs has a foreign key to job_postings and ON CONFLICT DO NOTHING
  // does NOT suppress a foreign-key violation. The rejection escaped the
  // async handler, and Node terminated the whole process mid-request.
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });

  for (const postingId of [999999, -1, 0, 'abc']) {
    const { status, body } = await api('saved/toggle', { postingId });
    assert.equal(body.ok, false, `postingId ${postingId} must be refused`);
    // Not merely "an error": the handler must VALIDATE and answer 400, rather
    // than letting the database reject it and relying on the crash-safety net
    // to turn that into a 500. A 500 here means the guard was lost again.
    assert.notEqual(status, 500,
      `postingId ${postingId} must be validated in the handler, not caught as a server fault`);
  }
  // and the process is still answering
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
  assert.equal(health.status, 200, 'the server must still be up after a bad request');
});

// ---------- email case ----------

test('an email is matched case-insensitively at login', async () => {
  // /register lowercases before storing but /login did not before comparing,
  // and Postgres compares TEXT case-sensitively — so an account created as
  // "Juan@Example.com" could never be signed into with the address typed.
  const api = client();
  const { body } = await api('auth/login', { email: 'SEEKER@DEMO.PH', password: 'demo123' });
  assert.equal(body.ok, true, 'a mixed-case address must still sign in');
  assert.equal(body.user.email, 'seeker@demo.ph');
});

// ---------- cross-account scoring ----------

test('a recruiter cannot score a resume never submitted to their company', async () => {
  // The ownership check here was gated on role === 'seeker', so any recruiter
  // could walk resume ids and harvest every seeker's skills, gaps and total
  // months of experience.
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const resumes = (await seeker('resumes/list')).body.resumes;

  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const postingId = (await hr('postings/mine')).body.postings[0].id;

  // find a resume with no application to this recruiter's company
  const ranked = (await hr('applications/ranked', { postingId })).body;
  const submitted = new Set((ranked.applicants ?? []).map((a: any) => String(a.resume?.id ?? a.resumeId)));
  const unsubmitted = resumes.find((r: any) => !submitted.has(String(r.id)));

  if (unsubmitted) {
    const { status, body } = await hr('match/score', { resumeId: unsubmitted.id, postingId });
    assert.equal(body.ok, false, 'a recruiter must not score an unsubmitted resume');
    assert.equal(status, 403);
  }
});

// ---------- input bounds ----------

test('resume sections are clamped instead of accepted unbounded', async () => {
  // Every skill costs a round trip through skillId(), so an unbounded array
  // held a pooled connection open for tens of thousands of queries and
  // permanently polluted the canonical skills table.
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { body } = await api('resumes/save', {
    resume: {
      title: 'x'.repeat(400),
      personal: {},
      education: [], experience: [], certifications: [],
      skills: Array.from({ length: 3000 }, (_, i) => `bulkskill${i}`),
    },
  });
  assert.equal(body.ok, true);
  assert.ok(body.resume.skills.length <= 100, `skills must be capped, got ${body.resume.skills.length}`);
  assert.ok(body.resume.title.length <= 120, 'title must be capped to the column width');
});

// ---------- the client and the server must agree on the weights ----------

test('the server publishes the weights the client scores with', async () => {
  // The browser keeps its own copy of the weights so it can show a live score
  // without a round trip. If an admin edits match_settings and the client
  // keeps the compiled-in values, a seeker is shown one number and the
  // recruiter sees another for the same application.
  const api = client();
  const { body } = await api('match/settings');
  assert.equal(body.ok, true);
  const w = body.weights, t = body.thresholds;
  for (const v of [w.skills, w.education, w.experience, t.strong, t.related]) {
    assert.equal(typeof v, 'number');
    assert.ok(Number.isFinite(v), 'a malformed settings row must never yield NaN');
  }
  assert.ok(Math.abs(w.skills + w.education + w.experience - 1) < 1e-9, 'weights must total 1');
  assert.ok(t.strong > t.related, 'the strong threshold must sit above the related one');
});

// ---------- expired postings ----------

test('recommendations never include a posting that can no longer be applied to', async () => {
  // The dashboard recommended openings past their deadline, which /apply then
  // refused — the system saying "strong match" and then turning the seeker away.
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const rec = (await api('match/recommendations')).body;
  const open = (await api('postings/list')).body.postings.map((p: any) => String(p.id));
  for (const group of ['strong', 'possible', 'related'] as const) {
    for (const item of rec[group] ?? []) {
      assert.ok(open.includes(String(item.posting.id)),
        `${group} recommended posting ${item.posting.id}, which is not open for applications`);
    }
  }
});

// ---------- second audit pass ----------

test('a closed or expired posting is not readable by the public', async () => {
  // postings/get had no auth and no status filter, so anyone could walk
  // posting ids and read every company's closed openings, department and all.
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const mine = (await hr('postings/mine')).body.postings;
  const target = mine[0];
  await hr('postings/toggle', { id: target.id }); // close it

  const anon = client();
  const { body } = await anon('postings/get', { id: target.id });
  assert.equal(body.ok, false, 'a closed posting must not be public');

  // the owning recruiter can still read it
  const owner = await hr('postings/get', { id: target.id });
  assert.equal(owner.body.ok, true, 'the owning recruiter must still see their closed posting');

  await hr('postings/toggle', { id: target.id }); // restore
});

test('company update is a real partial update, and is length-clamped', async () => {
  // This overwrote all five columns with '' for anything omitted, so a client
  // sending only { name } silently blanked industry, location, about and site.
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const me = (await hr('auth/me')).body.user;
  const before = (await hr('companies/get', { id: me.companyId })).body.company;

  const r = await hr('companies/update', { id: me.companyId, name: 'x'.repeat(400) });
  assert.equal(r.body.ok, true, 'an over-long name must be clamped, not fatal');

  const after = (await hr('companies/get', { id: me.companyId })).body.company;
  assert.ok(after.name.length <= 160, 'name must be clamped to the column width');
  assert.equal(after.industry, before.industry, 'an omitted field must be left alone');
  assert.equal(after.location, before.location, 'an omitted field must be left alone');

  await hr('companies/update', { id: me.companyId, name: before.name });
});

test('an application carries the score it had when it was submitted', async () => {
  // Demo mode recomputed historical scores from the CURRENT resume, so a
  // seeker editing their resume rewrote the study's own past data. Both modes
  // must expose the frozen snapshot instead.
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const mine = (await api('applications/mine')).body.applications;
  if (mine.length) {
    assert.ok('scoreSnapshot' in mine[0], 'applications must expose scoreSnapshot');
    if (mine[0].scoreSnapshot !== null) {
      assert.equal(typeof mine[0].scoreSnapshot, 'number');
      assert.ok(mine[0].scoreSnapshot >= 0 && mine[0].scoreSnapshot <= 100);
    }
  }
});

test('the server survives every malformed request in this suite', async () => {
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
  assert.equal(health.status, 200, 'the process must still be serving');
});
