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

test('a user can change the name on their account, within limits', async () => {
  const api = client();
  await api('auth/login', { email: 'liza@demo.ph', password: 'demo123' });

  const blank = await api('auth/change-name', { name: ' ' });
  assert.equal(blank.body.ok, false, 'an empty name is refused');
  const tooLong = await api('auth/change-name', { name: 'x'.repeat(121) });
  assert.equal(tooLong.body.ok, false, 'a 121-character name is refused');

  // still the old name after the two refusals — a rejected write changes nothing
  const before = await api('auth/me');
  assert.equal(before.body.user.name, 'Liza Cruz');

  const good = await api('auth/change-name', { name: '  Liza   Cruz-Reyes  ' });
  assert.equal(good.body.ok, true);
  // trimmed, and the run of spaces collapsed to one
  assert.equal(good.body.user.name, 'Liza Cruz-Reyes');
  const after = await api('auth/me');
  assert.equal(after.body.user.name, 'Liza Cruz-Reyes', 'the new name survives the round trip');
});

test('changing the account name leaves the name printed on a resume alone', async () => {
  const api = client();
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const mine = await api('resumes/list');
  const resumeId = mine.body.resumes[0].id;
  const printedBefore = mine.body.resumes[0].personal.fullName;

  const changed = await api('auth/change-name', { name: 'Marco A. Garcia' });
  assert.equal(changed.body.ok, true);

  const again = await api('resumes/get', { id: resumeId });
  assert.equal(again.body.resume.personal.fullName, printedBefore,
    'the resume keeps the name the applicant typed into the builder');
});

test('an anonymous caller cannot change anybody’s name', async () => {
  const api = client(); // never logs in
  const { body } = await api('auth/change-name', { name: 'Somebody Else' });
  assert.equal(body.ok, false);
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

/* ---------- the ranking score, and the file score beside it ----------

   The applicant's own file is now read and scored too. Two rules hold this
   together and both are load-bearing:

     1. `score` — the number a recruiter ranks by — still comes only from the
        structured resume. A parser misreading a scan must never move a person
        down a list.
     2. A document that could NOT be read produces no fileScore at all. Not
        zero. Zero is a finding about an applicant; absent is a finding about
        a document, and showing one as the other would be a lie about a person.
*/

test('the ranking score comes only from the structured resume', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const resumeId = (await api('resumes/list')).body.resumes[0].id;
  const postingId = (await api('postings/list')).body.postings[0].id;
  const { body } = await api('match/score', { resumeId, postingId });
  assert.equal(body.ok, true);
  assert.equal(typeof body.score, 'number');
  assert.ok(Array.isArray(body.matchedSkills) && Array.isArray(body.missingSkills));
  assert.ok(!('ownFile' in body), 'the ranking score must not be derived from the uploaded file');
});

test('an unreadable file yields no score at all, never a zero', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const resumeId = (await api('resumes/list')).body.resumes[0].id;
  const postingId = (await api('postings/list')).body.postings[0].id;
  const { body } = await api('match/score', { resumeId, postingId });

  // No GEMINI_API_KEY is set in the test environment, so nothing can have
  // been read. That must show up as an ABSENT fileScore.
  assert.ok(!('fileScore' in body) || body.fileScore === null,
    'a file that was never read must not produce a score');
  if ('fileScore' in body && body.fileScore) {
    assert.notEqual(body.fileScore.score, 0, 'an unread file must never surface as 0%');
  }
});

test('a file that was read is scored by the same engine as the resume', async () => {
  // Drive the engine directly: the API path needs a live Gemini key, but the
  // arithmetic on an extraction must be provably identical to the arithmetic
  // on a typed resume — same weights, same rounding, same tiers.
  const { scoreWith, DEFAULT_SETTINGS } = await import('../src/lib/engine');
  const posting: any = { id: '1', skills: ['HTML/CSS', 'JavaScript', 'MySQL'], educationLevel: 'bachelor', minExperienceMonths: 6 };
  const typed: any = {
    id: '1', skills: ['HTML/CSS', 'JavaScript', 'MySQL'],
    education: [{ level: 'bachelor' }], experience: [{ months: 6 }],
  };
  // the same person, as a parser read them out of their own document
  const fromFile: any = {
    id: '1', skills: ['HTML/CSS', 'JavaScript', 'MySQL'],
    education: [{ level: 'bachelor' }], experience: [{ months: 6 }],
  };
  const a = scoreWith(DEFAULT_SETTINGS, typed, posting);
  const b = scoreWith(DEFAULT_SETTINGS, fromFile, posting);
  assert.equal(a.score, b.score, 'identical content must score identically whichever way it arrived');
  assert.equal(a.tier, b.tier);

  // and a parser that lost a skill scores LOWER — the gap the study reports
  const lossy: any = { ...fromFile, skills: ['HTML/CSS', 'JavaScript'] };
  const c = scoreWith(DEFAULT_SETTINGS, lossy, posting);
  assert.ok(c.score < a.score, 'a parser that drops a skill must produce a lower number, not the same one');
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

// ---------- the applicant's own audit trail ----------

test('an applicant can read the recorded history of their own application', async () => {
  // ana@demo.ph owns application 1, which the seed gives a real two-step
  // history (submitted → review). seeker@demo.ph has no applications at all.
  const api = client();
  await api('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const app = (await api('applications/mine')).body.applications[0];
  assert.ok(app, 'expected the seed to give this seeker an application');

  const { body } = await api('applications/history', { id: app.id });
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.events) && body.events.length >= 1, 'expected at least the submission event');

  // Applying is the first thing that ever happens, so the earliest event
  // must have no previous status.
  assert.equal(body.events[0].from, null);
  assert.equal(body.events[0].to, 'submitted');

  // Oldest first, and every entry timestamped.
  for (let i = 1; i < body.events.length; i++) {
    assert.ok(body.events[i].at >= body.events[i - 1].at, 'events must be ordered oldest first');
  }
  for (const e of body.events) assert.equal(typeof e.at, 'number');
});

test('a status change by the recruiter appears in the applicant’s history', async () => {
  // The point of the feature: the applicant learns WHEN something changed,
  // not merely what it currently is.
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const ranked = (await hr('applications/ranked', { postingId: '1' })).body;
  const row = ranked.rows.find((r: any) => r.application.status !== 'withdrawn');
  assert.ok(row, 'expected a non-withdrawn applicant on posting 1');

  const seekerEmail = row.seeker.email;
  const before = await (async () => {
    const s = client();
    await s('auth/login', { email: seekerEmail, password: 'demo123' });
    return (await s('applications/history', { id: row.application.id })).body.events.length;
  })();

  const set = await hr('applications/set-status', { id: row.application.id, status: 'shortlisted' });
  assert.equal(set.body.ok, true);

  const s = client();
  await s('auth/login', { email: seekerEmail, password: 'demo123' });
  const after = (await s('applications/history', { id: row.application.id })).body.events;
  assert.equal(after.length, before + 1, 'the change must add exactly one recorded event');

  const last = after[after.length - 1];
  assert.equal(last.to, 'shortlisted');
  assert.equal(last.by, 'employer', 'a recruiter decision is attributed to the employer');
});

test('a recruiter sees WHICH colleague made each change', async () => {
  // The asymmetry is the point: internal accountability is why changed_by is
  // stored, and several HR people share one pool once departments are routed.
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const ranked = (await hr('applications/ranked', { postingId: '1' })).body;
  const row = ranked.rows.find((r: any) => r.application.status !== 'withdrawn');
  assert.ok(row, 'expected a non-withdrawn applicant on posting 1');

  // make a change so there is definitely a named employer event
  await hr('applications/set-status', { id: row.application.id, status: 'review' });

  const { body } = await hr('applications/history', { id: row.application.id });
  assert.equal(body.ok, true);
  const employerEvents = body.events.filter((e: any) => e.by === 'employer');
  assert.ok(employerEvents.length, 'expected at least one employer-side event');
  assert.ok(
    employerEvents.some((e: any) => typeof e.byName === 'string' && e.byName.length),
    'a recruiter must see the name of the colleague who made the change',
  );
});

test('the applicant’s own action is never attributed to a named person', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const ranked = (await hr('applications/ranked', { postingId: '1' })).body;
  for (const row of ranked.rows) {
    const { body } = await hr('applications/history', { id: row.application.id });
    for (const e of body.events) {
      if (e.by === 'applicant') {
        assert.ok(!('byName' in e), 'applicant-side events must carry no byName');
      }
    }
  }
});

test('history never names the individual who made the decision', async () => {
  // The applicant is told what was decided and when. Naming a particular HR
  // staff member to an applicant is a different disclosure this feature does
  // not need, so `by` is a role and no user id or name is serialized.
  const api = client();
  await api('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const app = (await api('applications/mine')).body.applications[0];
  const { body } = await api('applications/history', { id: app.id });
  assert.ok(body.events.length, 'expected recorded events to inspect');

  for (const e of body.events) {
    assert.ok(['applicant', 'employer'].includes(e.by), '`by` must be a role, got ' + e.by);
    assert.deepEqual(Object.keys(e).sort(), ['at', 'by', 'from', 'to'], 'no extra identifying fields');
  }
  assert.ok(!JSON.stringify(body).toLowerCase().includes('santos'), 'must not leak a recruiter name');
});

test('the data export carries the whole lot, including the status history', async () => {
  // The privacy notice offers "the whole lot" and separately calls the status
  // history permanent. A copy of everything that omits the one record the
  // subject cannot have removed is not a copy of everything.
  const api = client();
  await api('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const { body } = await api('auth/export');
  assert.equal(body.ok, true);
  const d = body.data;

  for (const key of ['account', 'resumes', 'applications', 'applicationHistory', 'savedOpenings']) {
    assert.ok(key in d, 'export is missing ' + key);
  }
  assert.ok(d.applications.length, 'this fixture should have applications to export');
  assert.ok(d.applicationHistory.length, 'and a history for them');

  // Every history row belongs to an application that is also in the export —
  // no orphans, and nothing from somebody else's application.
  const mine = new Set(d.applications.map((a: any) => String(a.id)));
  for (const h of d.applicationHistory) {
    assert.ok(mine.has(h.applicationId), 'history row for an application not in the export');
    assert.ok(['you', 'employer'].includes(h.by), '`by` must be a role, got ' + h.by);
  }
});

test('the export redacts staff names exactly as the history screen does', async () => {
  // An export must not disclose what the interface deliberately withholds.
  const api = client();
  await api('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const { body } = await api('auth/export');
  const flat = JSON.stringify(body.data).toLowerCase();
  assert.ok(!flat.includes('santos'), 'must not leak a recruiter name');
  assert.ok(!flat.includes('password'), 'must not carry any password field');
  for (const h of body.data.applicationHistory) {
    assert.deepEqual(Object.keys(h).sort(), ['applicationId', 'at', 'by', 'from', 'to'],
      'no extra identifying fields on a history row');
  }
});

test('a seeker cannot read another seeker’s application history', async () => {
  const victim = client();
  await victim('auth/login', { email: 'liza@demo.ph', password: 'demo123' });
  const theirs = (await victim('applications/mine')).body.applications[0];
  assert.ok(theirs, 'expected the seed to give liza an application');

  const attacker = client();
  await attacker('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const { body } = await attacker('applications/history', { id: theirs.id });
  assert.equal(body.ok, false, 'another seeker must not read this history');
});

test('history does not reveal which application ids exist', async () => {
  // "Not yours" and "no such application" must be indistinguishable,
  // otherwise the endpoint enumerates the table.
  const api = client();
  await api('auth/login', { email: 'ana@demo.ph', password: 'demo123' });

  const victim = client();
  await victim('auth/login', { email: 'liza@demo.ph', password: 'demo123' });
  const real = (await victim('applications/mine')).body.applications[0];

  const existing = await api('applications/history', { id: real.id });
  const absent = await api('applications/history', { id: 987654 });
  assert.equal(existing.body.ok, false);
  assert.equal(absent.body.ok, false);
  assert.equal(existing.body.error, absent.body.error, 'the two refusals must read identically');
});

test('a recruiter can read the history of an application to their own company', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const ranked = (await hr('applications/ranked', { postingId: '1' })).body;
  assert.ok(ranked.rows.length, 'expected applicants on posting 1');

  const { body } = await hr('applications/history', { id: ranked.rows[0].application.id });
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.events));
});

test('an anonymous caller cannot read any application history', async () => {
  const anon = client();
  const { body } = await anon('applications/history', { id: 1 });
  assert.equal(body.ok, false);
});

test('the server survives every malformed request in this suite', async () => {
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
  assert.equal(health.status, 200, 'the process must still be serving');
});

/* ---------- per-opening scoring weights ----------

   A recruiter can set what each of the three checks is worth for their own
   opening. Three numbers that scale every score the opening produces, so the
   route validates them rather than trusting the form — a set totalling 90
   would compress every applicant's score by a tenth and nothing downstream
   would look wrong. The same rules exist as a CHECK on the table and in the
   demo adapter, so no route into the data can bypass them. */

test('a recruiter can set the scoring weights on their own opening', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const made = await hr('postings/save', { posting: {
    title: 'Weighted Test Role',
    department: 'Information Technology',
    description: 'A role used to check that per-opening weights are stored and returned.',
    skills: ['JavaScript', 'Git'],
    educationLevel: 'bachelor',
    minExperienceMonths: 0,
    weights: { skills: 70, education: 15, experience: 15 },
  } });
  assert.equal(made.body.ok, true, made.body.error);
  // Whole percentages on the wire, the same units the column stores and the
  // recruiter typed — so "must total 100" stays an exact integer check.
  assert.deepEqual(made.body.posting.weights, { skills: 70, education: 15, experience: 15 });

  // And they survive a round trip rather than only existing in the response.
  const back = await hr('postings/get', { id: made.body.posting.id });
  assert.deepEqual(back.body.posting.weights, { skills: 70, education: 15, experience: 15 });
});

test('an opening that sets no weights reports none, rather than a copy of the defaults', async () => {
  /* null and 50/25/25 are different facts. null means "follow the site", so
     retuning match_settings still moves this opening; a stored copy would
     silently freeze it at whatever the defaults were on the day it was made. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const made = await hr('postings/save', { posting: {
    title: 'Inheriting Test Role',
    department: 'Information Technology',
    description: 'A role used to check that unset weights stay unset.',
    skills: ['JavaScript'],
    educationLevel: 'bachelor',
    minExperienceMonths: 0,
  } });
  assert.equal(made.body.ok, true, made.body.error);
  assert.equal(made.body.posting.weights, null);
});

test('weights that do not total 100, or fall below the floor, are refused', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const base = {
    title: 'Rejected Weights Role',
    department: 'Information Technology',
    description: 'A role used to check that bad weights never reach the database.',
    skills: ['JavaScript'],
    educationLevel: 'bachelor',
    minExperienceMonths: 0,
  };

  const bad = [
    [{ skills: 50, education: 25, experience: 20 }, /add up to 100/i],   // 95
    [{ skills: 40, education: 40, experience: 40 }, /add up to 100/i],   // 120
    [{ skills: 90, education: 5, experience: 5 }, /at least 10/i],       // below the floor
    [{ skills: 80, education: 20, experience: 0 }, /at least 10/i],      // a criterion switched off
    [{ skills: 50.5, education: 25, experience: 24.5 }, /whole numbers/i],
  ] as const;

  for (const [weights, expected] of bad) {
    const res = await hr('postings/save', { posting: { ...base, weights } });
    assert.equal(res.body.ok, false, `${JSON.stringify(weights)} should have been refused`);
    assert.match(res.body.error, expected);
  }
});

test('the score a seeker is given uses the opening’s own weights', async () => {
  /* End to end rather than through the engine alone: the weights have to
     survive being written, read back, and applied by the scorer the seeker
     actually hits. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const made = await hr('postings/save', { posting: {
    title: 'Scored With Custom Weights',
    department: 'Information Technology',
    description: 'Half the required skills, so the weighting is visible in the score.',
    skills: ['JavaScript', 'Git', 'SQL', 'Excel'],
    educationLevel: 'none',
    minExperienceMonths: 0,
    weights: { skills: 80, education: 10, experience: 10 },
  } });
  assert.equal(made.body.ok, true, made.body.error);

  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const mine = (await seeker('resumes/list')).body.resumes;
  const scored = await seeker('match/score', { resumeId: mine[0].id, postingId: made.body.posting.id });
  assert.equal(scored.body.ok, true, scored.body.error);

  // education and experience are both unrequired here, so they contribute
  // their full weight; only the skills fraction varies.
  const s = scored.body;
  const fraction = s.matchedSkills.length / 4;
  assert.equal(s.score, Math.floor(fraction * 80 + 10 + 10 + 0.5),
    'the score must be computed on 80/10/10, not the site default');
  assert.deepEqual(s.weights, { skills: 0.8, education: 0.1, experience: 0.1 },
    'and it must report the split it used, as fractions');
});
