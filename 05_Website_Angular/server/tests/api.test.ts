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

const DB = process.env.TEST_DB_NAME || 'linaw_apitest';
const PORT = Number(process.env.TEST_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}/api`;
const SCHEMA = path.join(__dirname, '..', '..', 'db', 'linaw_ph.sql');

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

/** A tiny cookie-jar fetch — enough to carry one session per "user".
 *  `.upload` is the same jar sending multipart instead of JSON, for the one
 *  endpoint that takes a file. Content-Type is left unset on purpose: fetch
 *  writes it from the FormData, boundary included. */
function client() {
  let cookie = '';
  const keep = (res: Response) => {
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  };
  const call = async function call(route: string, body: any = {}): Promise<any> {
    const res = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    keep(res);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } as {
    (route: string, body?: any): Promise<any>;
    upload(route: string, form: FormData): Promise<any>;
  };
  call.upload = async (route: string, form: FormData) => {
    const res = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}) },
      body: form,
    });
    keep(res);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return call;
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

  const blank = await api('auth/change-name', { firstName: ' ', lastName: 'Cruz' });
  assert.equal(blank.body.ok, false, 'an empty first name is refused');
  const tooLong = await api('auth/change-name', { firstName: 'x'.repeat(61), lastName: 'Cruz' });
  assert.equal(tooLong.body.ok, false, 'a 61-character first name is refused');
  const lastTooLong = await api('auth/change-name', { firstName: 'Liza', lastName: 'y'.repeat(61) });
  assert.equal(lastTooLong.body.ok, false, 'a 61-character last name is refused');

  // still the old name after the refusals — a rejected write changes nothing
  const before = await api('auth/me');
  assert.equal(before.body.user.name, 'Liza Cruz');
  assert.equal(before.body.user.firstName, 'Liza');
  assert.equal(before.body.user.lastName, 'Cruz');

  const good = await api('auth/change-name', { firstName: '  Liza  ', lastName: '  Cruz-Reyes  ' });
  assert.equal(good.body.ok, true);
  // trimmed, and `name` is derived from the two parts rather than stored
  assert.equal(good.body.user.firstName, 'Liza');
  assert.equal(good.body.user.lastName, 'Cruz-Reyes');
  assert.equal(good.body.user.name, 'Liza Cruz-Reyes');
  const after = await api('auth/me');
  assert.equal(after.body.user.name, 'Liza Cruz-Reyes', 'the new name survives the round trip');
});

test('a first name on its own is a complete name', async () => {
  // A mononym is a real way for a person to be named, and a sign-up form is
  // the wrong place to rule on it. The derived full name carries no trailing
  // space, because the database trims the join.
  const api = client();
  await api('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const { body } = await api('auth/change-name', { firstName: 'Ana', lastName: '' });
  assert.equal(body.ok, true);
  assert.equal(body.user.lastName, '');
  assert.equal(body.user.name, 'Ana');
});

test('changing the account name leaves the name printed on a resume alone', async () => {
  const api = client();
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const mine = await api('resumes/list');
  const resumeId = mine.body.resumes[0].id;
  const printedBefore = mine.body.resumes[0].personal.fullName;

  const changed = await api('auth/change-name', { firstName: 'Marco A.', lastName: 'Garcia' });
  assert.equal(changed.body.ok, true);

  const again = await api('resumes/get', { id: resumeId });
  assert.equal(again.body.resume.personal.fullName, printedBefore,
    'the resume keeps the name the applicant typed into the builder');
});

test('an anonymous caller cannot change anybody’s name', async () => {
  const api = client(); // never logs in
  const { body } = await api('auth/change-name', { firstName: 'Somebody', lastName: 'Else' });
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

// ---------- education and skills cannot be skipped ----------

test('a resume with no education is refused', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { body } = await api('resumes/save', {
    resume: {
      title: 'No education', personal: { fullName: 'Test Person', email: 't@t.ph' },
      education: [], experience: [], certifications: [], skills: ['Communication'],
    },
  });
  assert.equal(body.ok, false, 'education is one of the three scored components; it cannot be empty');
  assert.match(body.error, /education/i);
});

test('a resume with no skills is refused', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { body } = await api('resumes/save', {
    resume: {
      title: 'No skills', personal: { fullName: 'Test Person', email: 't@t.ph' },
      education: [{ school: 'Holy Angel University', degree: 'BSIT', level: 'bachelor' }],
      experience: [], certifications: [], skills: [],
    },
  });
  assert.equal(body.ok, false, 'skills carry the largest weight; they cannot be empty');
  assert.match(body.error, /skill/i);
});

test('a blank education row does not satisfy the requirement', async () => {
  // Opening the education step and typing nothing leaves an entry object
  // behind. Counting it would let the rule be met by a row nobody filled in.
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { body } = await api('resumes/save', {
    resume: {
      title: 'Blank row', personal: { fullName: 'Test Person', email: 't@t.ph' },
      education: [{ school: '  ', degree: '', level: 'bachelor' }],
      experience: [], certifications: [], skills: ['Communication'],
    },
  });
  assert.equal(body.ok, false, 'an entry with no school and no degree is not an education entry');
});

test('a whitespace-only skill does not satisfy the requirement', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { body } = await api('resumes/save', {
    resume: {
      title: 'Blank skill', personal: { fullName: 'Test Person', email: 't@t.ph' },
      education: [{ school: 'Holy Angel University', degree: 'BSIT', level: 'bachelor' }],
      experience: [], certifications: [], skills: ['   '],
    },
  });
  assert.equal(body.ok, false);
});

test('a resume carrying both still saves', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { body } = await api('resumes/save', {
    resume: {
      title: 'Complete', personal: { fullName: 'Test Person', email: 't@t.ph' },
      education: [{ school: 'Holy Angel University', degree: 'BSIT', level: 'bachelor' }],
      experience: [], certifications: [], skills: ['Communication', 'Teamwork'],
    },
  });
  assert.equal(body.ok, true, 'the rule must not block a resume that has both');
  assert.equal(body.resume.skills.length, 2);
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
      // Education is required on save, so this carries a real entry. The
      // clamping this test is about is unaffected by it.
      education: [{ school: 'Holy Angel University', degree: 'BSIT', level: 'bachelor' }],
      experience: [], certifications: [],
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
  await hr('applications/set-status', { id: row.application.id, status: 'scheduling' });

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
  // The four optional components the recruiter left alone come back as 0, not
  // absent: an opening that scores nothing on them is a stated fact, and it is
  // why openings written before those columns existed still total 100.
  const seven = { skills: 70, education: 15, experience: 15,
    certifications: 0, projects: 0, languages: 0, references: 0, relevance: 0, field: 0 };
  assert.deepEqual(made.body.posting.weights, seven);

  // And they survive a round trip rather than only existing in the response.
  const back = await hr('postings/get', { id: made.body.posting.id });
  assert.deepEqual(back.body.posting.weights, seven);
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
  assert.deepEqual(s.weights, { skills: 0.8, education: 0.1, experience: 0.1,
    certifications: 0, projects: 0, languages: 0, references: 0, relevance: 0, field: 0 },
    'and it must report the split it used, as fractions');
});

test('editing a resume after applying does not reorder the recruiter’s shortlist', async () => {
  /* THE ANTI-GAMING GUARANTEE, and the reason the ranked list reads
     score_snapshot rather than the live score.

     Required skills are printed on the posting, so an applicant can always
     work out their own gap. What must not follow is that closing the gap
     AFTER applying moves them up a shortlist the recruiter has already
     worked from. This test would have passed before the fix for the wrong
     reason — nothing asserted the ordering at all — so it exists to keep
     the behaviour from being quietly reverted. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const made = await hr('postings/save', { posting: {
    title: 'Snapshot Ranking Check',
    department: 'Information Technology',
    description: 'Requires four skills so a later edit can visibly change the live score.',
    skills: ['JavaScript', 'Git', 'SQL', 'Excel'],
    educationLevel: 'none',
    minExperienceMonths: 0,
  } });
  assert.equal(made.body.ok, true, made.body.error);
  const postingId = made.body.posting.id;

  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const resume = (await seeker('resumes/list')).body.resumes[0];

  const applied = await seeker('applications/apply', { resumeId: resume.id, postingId });
  assert.equal(applied.body.ok, true, applied.body.error);

  const first = (await hr('applications/ranked', { postingId })).body
    .rows.find((r: any) => String(r.resume.id) === String(resume.id));
  assert.ok(first, 'the applicant should be on the shortlist');
  const scoreAtApplication = first.score;
  assert.equal(first.scoreDrifted, false, 'nothing has changed yet');

  // Now add every required skill — the exact exploit the review described.
  // Each one is given a source, so this test stays about SNAPSHOT RANKING and
  // is not quietly weakened by the separate half-credit rule; the evidence
  // feature has its own tests below.
  const full = (await seeker('resumes/get', { id: resume.id })).body.resume;
  full.skills = ['JavaScript', 'Git', 'SQL', 'Excel'];
  /* An earlier test in this file leaves a bare resume at the top of the list,
     so this one may have no entries at all. Give it a job, and point all four
     skills at it: that keeps this test about SNAPSHOT RANKING rather than
     letting the separate half-credit rule quietly change what it measures.
     The posting asks for no experience, so the added months move nothing. */
  full.experience = [{ position: 'Web Development Intern', company: 'LGU San Fernando', months: 4, description: '' }];
  const source = { kind: 'experience', ref: 'Web Development Intern, LGU San Fernando' };
  full.skillEvidence = { JavaScript: source, Git: source, SQL: source, Excel: source };
  const saved = await seeker('resumes/save', { resume: full });
  assert.equal(saved.body.ok, true, saved.body.error);

  const after = (await hr('applications/ranked', { postingId })).body
    .rows.find((r: any) => String(r.resume.id) === String(resume.id));

  assert.equal(after.score, scoreAtApplication,
    'the ranked score must stay at the value recorded when they applied');
  assert.equal(after.liveScore, 100,
    'the live score should reflect the improved resume');
  assert.equal(after.scoreDrifted, true,
    'and the recruiter must be told the resume changed');
});

test('a skill’s first-seen date survives an unrelated save', async () => {
  /* resumes.ts deletes and recreates every child row on save, so a column with
     a database default would be re-stamped every time the applicant edited
     anything at all — and would then report that every skill was added today.
     The route carries the old timestamps forward; this is the test for that,
     because the failure is silent and the column would look populated. */
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const listed = (await seeker('resumes/list')).body.resumes[0];

  const before = (await seeker('resumes/get', { id: listed.id })).body.resume;
  assert.ok(before.skillsAddedAt, 'the serializer should report first-seen dates');
  const originals = { ...before.skillsAddedAt };
  const anExistingSkill = Object.keys(originals)[0];
  assert.ok(anExistingSkill, 'the seeded resume should already have skills');

  // Change something that has nothing to do with skills, and add one new skill.
  before.personal.summary = 'Edited for the first-seen-date test.';
  before.skills = [...before.skills, 'Zendesk'];
  const saved = await seeker('resumes/save', { resume: before });
  assert.equal(saved.body.ok, true, saved.body.error);

  const after = (await seeker('resumes/get', { id: listed.id })).body.resume;
  assert.equal(after.skillsAddedAt[anExistingSkill], originals[anExistingSkill],
    'an existing skill must keep the date it was first listed');
  assert.ok(after.skillsAddedAt['Zendesk'] >= originals[anExistingSkill],
    'and a genuinely new skill is dated when it was actually added');
});

test('the applicant is told WHY, but never WHO — and screening notes stay internal', async () => {
  /* Two rules that look alike and are not, so they are tested together to
     keep them from being collapsed into one gate again:

       · the REASON reaches the applicant. The study's stated problem is
         applicants who apply and hear nothing back; recording why and then
         withholding it from the person whose plans depend on it would argue
         against the paper's own thesis.
       · the DECIDER's name does not, and neither do SCREENING NOTES. A note
         its subject may read is a note nobody writes honestly, and naming an
         individual staff member to a rejected applicant is a different
         disclosure from telling them what was decided. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const ranked = (await hr('applications/ranked', { postingId: '1' })).body;
  const row = ranked.rows.find((r: any) => r.application.status !== 'withdrawn');
  assert.ok(row, 'expected a non-withdrawn applicant on posting 1');

  const set = await hr('applications/set-status', {
    id: row.application.id, status: 'rejected', reason: 'stronger_candidate',
  });
  assert.equal(set.body.ok, true, set.body.error);

  const noted = await hr('applications/note-add', {
    id: row.application.id, body: 'Called 3pm, no answer. Following up Thursday.',
  });
  assert.equal(noted.body.ok, true, noted.body.error);

  // The recruiter sees both.
  const hrHistory = (await hr('applications/history', { id: row.application.id })).body;
  assert.ok(hrHistory.events.some((e: any) => e.reason === 'stronger_candidate'),
    'the employer’s own staff should see the reason');
  const hrNotes = (await hr('applications/notes', { id: row.application.id })).body;
  assert.equal(hrNotes.notes.length, 1);

  // The applicant sees the reason, not the notes — and has no route for them.
  const seeker = client();
  await seeker('auth/login', { email: row.seeker.email, password: 'demo123' });

  const theirHistory = (await seeker('applications/history', { id: row.application.id })).body;
  assert.equal(theirHistory.ok, true, 'the applicant may read their own trail');
  assert.ok(theirHistory.events.some((e: any) => e.reason === 'stronger_candidate'),
    'the applicant must be told the reason their application did not proceed');
  for (const e of theirHistory.events) {
    assert.equal(e.byName, undefined, 'but never the name of the staff member who decided it');
  }

  const theirNotes = await seeker('applications/notes', { id: row.application.id });
  assert.equal(theirNotes.body.ok, false, 'the notes route is recruiter-only');
});

test('a skill with no source scores less than the same skill with one', async () => {
  /* END TO END, through the real save route and the real serializer: the same
     resume, the same posting, the same skills — the ONLY difference is whether
     the applicant said where they used them. The engine tests pin the
     arithmetic; this proves the source actually survives the round trip
     through the database, which is where a feature like this silently dies. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const made = await hr('postings/save', { posting: {
    title: 'Evidence Round Trip',
    department: 'Information Technology',
    description: 'Two required skills, so the half-credit difference is a whole tier.',
    skills: ['JavaScript', 'Git'],
    educationLevel: 'none',
    minExperienceMonths: 0,
  } });
  assert.equal(made.body.ok, true, made.body.error);

  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const listed = (await seeker('resumes/list')).body.resumes[0];
  const r = (await seeker('resumes/get', { id: listed.id })).body.resume;
  const postingId = made.body.posting.id;

  /* A source must point at an entry the resume actually carries, so the
     resume needs one. An earlier test leaves a bare resume at the top of the
     list, which is exactly the state this feature has to handle: with nothing
     to point at, no skill can be sourced at all. */
  const source = { kind: 'experience', ref: 'Web Development Intern, LGU San Fernando' };
  r.experience = [{ position: 'Web Development Intern', company: 'LGU San Fernando', months: 4, description: '' }];
  r.skills = ['JavaScript', 'Git'];
  r.skillEvidence = { JavaScript: source, Git: source };
  assert.equal((await seeker('resumes/save', { resume: r })).body.ok, true);

  const sourced = (await seeker('match/score', { resumeId: r.id, postingId })).body;
  assert.equal(sourced.ok, true, sourced.error);
  assert.deepEqual(sourced.unevidencedMatches, []);

  // Same skills, sources removed.
  const again = (await seeker('resumes/get', { id: listed.id })).body.resume;
  // Read back as a LIST of sources per skill (a skill can be learned in
  // several places); a single source is stored as a one-element list.
  assert.deepEqual(again.skillEvidence, { JavaScript: [source], Git: [source] },
    'the source must survive the save — it is stored on resume_skills, which is deleted and rewritten every save');
  again.skillEvidence = {};
  assert.equal((await seeker('resumes/save', { resume: again })).body.ok, true);

  const unsourced = (await seeker('match/score', { resumeId: r.id, postingId })).body;
  assert.ok(unsourced.score < sourced.score,
    `an unsourced skill must score lower (${unsourced.score} vs ${sourced.score})`);
  assert.ok(unsourced.score > 0, 'but it must still count — half credit, not zero');
  assert.deepEqual(unsourced.unevidencedMatches.sort(), ['Git', 'JavaScript']);
});

test('a skill can be linked to several sources, and all of them survive the round trip', async () => {
  /* The multi-source model: a skill learned in more than one place carries a
     LIST of sources. Extra sources never lift the score above full — a skill
     with any source is already full — they only record where it came from for
     the recruiter. This proves the whole list persists through the save. */
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const listed = (await seeker('resumes/list')).body.resumes[0];
  const r = (await seeker('resumes/get', { id: listed.id })).body.resume;

  r.experience = [{ position: 'Web Development Intern', company: 'LGU San Fernando', months: 4, description: '' }];
  r.projects = [{ name: 'Barangay records system' }];
  r.skills = ['JavaScript'];
  const two = [
    { kind: 'experience', ref: 'Web Development Intern, LGU San Fernando' },
    { kind: 'project', ref: 'Barangay records system' },
  ];
  r.skillEvidence = { JavaScript: two };
  assert.equal((await seeker('resumes/save', { resume: r })).body.ok, true);

  const back = (await seeker('resumes/get', { id: listed.id })).body.resume;
  assert.deepEqual(back.skillEvidence, { JavaScript: two },
    'both sources for the skill must come back, in order');

  // Duplicates fold, and a source the resume no longer contains is dropped —
  // the rest survive.
  r.skillEvidence = { JavaScript: [two[0], two[0], { kind: 'project', ref: 'Does Not Exist' }] };
  assert.equal((await seeker('resumes/save', { resume: r })).body.ok, true);
  const folded = (await seeker('resumes/get', { id: listed.id })).body.resume;
  assert.deepEqual(folded.skillEvidence, { JavaScript: [two[0]] },
    'a duplicate is folded and an unbacked source dropped, leaving the one real source');
});

test('a source the resume does not contain is refused', async () => {
  /* The whole mechanism rests on a source being something the applicant
     already wrote down elsewhere. If free text got through, the skill and its
     justification could be invented in the same keystroke and the feature
     would be theatre. */
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const listed = (await seeker('resumes/list')).body.resumes[0];
  const r = (await seeker('resumes/get', { id: listed.id })).body.resume;

  r.experience = [{ position: 'Web Development Intern', company: 'LGU San Fernando', months: 4, description: '' }];
  r.skills = ['JavaScript'];
  r.skillEvidence = { JavaScript: { kind: 'experience', ref: 'Chief Architect, NASA' } };
  const saved = await seeker('resumes/save', { resume: r });
  assert.equal(saved.body.ok, true, 'the save itself still succeeds — only the bad source is dropped');
  assert.deepEqual(saved.body.resume.skillEvidence, {},
    'a source naming a job that is not on the resume must not be stored');

  // And an unknown kind is refused just as firmly.
  r.skillEvidence = { JavaScript: { kind: 'vibes', ref: 'Web Development Intern, LGU San Fernando' } };
  const second = await seeker('resumes/save', { resume: r });
  assert.equal(second.body.ok, true);
  assert.deepEqual(second.body.resume.skillEvidence, {});
});

test('the source is never part of the resume’s own skills list', async () => {
  /* The applicant was promised the link stays off their resume. The printed
     sheet renders `skills`, so the guarantee is that `skills` stays a flat
     list of plain names with no company welded on — checked here rather than
     trusted, because the day someone folds the two together to save a query
     is the day fourteen resume designs start printing employer names. */
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const listed = (await seeker('resumes/list')).body.resumes[0];
  const r = (await seeker('resumes/get', { id: listed.id })).body.resume;

  r.experience = [{ position: 'Web Development Intern', company: 'LGU San Fernando', months: 4, description: '' }];
  r.skills = ['JavaScript'];
  r.skillEvidence = { JavaScript: { kind: 'experience', ref: 'Web Development Intern, LGU San Fernando' } };
  const saved = (await seeker('resumes/save', { resume: r })).body.resume;

  assert.deepEqual(saved.skills, ['JavaScript']);
  for (const s of saved.skills) {
    assert.equal(typeof s, 'string');
    assert.ok(!s.includes('LGU San Fernando'), 'the employer name must never appear in the printed skills list');
  }
});

test('a resume imported from a CV is not docked for a question it was never asked', async () => {
  /* The regression this exists for. The engine already distinguishes an
     ABSENT evidence map ("never asked", full credit) from an EMPTY one
     ("asked, declined", half credit) — but the serializer used to emit a map
     either way. An import from an uploaded CV therefore arrived looking like
     an applicant who had been shown the question and refused it, and the same
     document scored 65 where it should have scored 80.

     The builder always sends a skillEvidence key, empty or not, because it is
     the screen that asks. An import sends none. That is the whole signal. */
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });

  const imported: any = {
    title: 'Imported from CV', template: 'chronological', design: 'classic',
    personal: { fullName: 'Jeanky Mendez', email: 'jm@example.ph' },
    education: [{ school: 'HAU', degree: 'BSIT', level: 'bachelor', year: '2024' }],
    experience: [{ position: 'IT Intern', company: 'Clark BPO', months: 12, description: '' }],
    skills: ['JavaScript', 'Git'],
    // NO skillEvidence key at all — nobody asked.
  };
  const made = await seeker('resumes/save', { resume: imported });
  assert.equal(made.body.ok, true);
  assert.ok(!('skillEvidence' in made.body.resume),
    'an imported resume must carry NO evidence map, so the engine reads it as never asked');

  // Reopened later, it still reads as never asked.
  const again = (await seeker('resumes/get', { id: made.body.resume.id })).body.resume;
  assert.ok(!('skillEvidence' in again), 'and it must survive the round trip that way');

  // Now the applicant opens the builder, which asks and links nothing.
  again.skillEvidence = {};
  const opened = await seeker('resumes/save', { resume: again });
  assert.equal(opened.body.ok, true);
  assert.deepEqual(opened.body.resume.skillEvidence, {},
    'once asked, an empty map is emitted and partial credit applies');

  // And the flag does not flip back on a later save that omits the key.
  const stripped = (await seeker('resumes/get', { id: made.body.resume.id })).body.resume;
  delete stripped.skillEvidence;
  const relisted = await seeker('resumes/save', { resume: stripped });
  assert.deepEqual(relisted.body.resume.skillEvidence, {},
    'having been asked once, the resume stays asked');
});

test('a skill may point at the uploaded file, but only once the file is really there', async () => {
  /* The imported-CV gap, closed end to end. A resume typed into the builder
     has jobs and projects to point a skill at; one read out of an uploaded CV
     often has only the file. Offering the file as a source is what makes the
     two score alike — and reading its name from the STORED ROW rather than
     from the payload is what stops it becoming free text under another name.

     Order matters here and the builder follows it: save, attach, then link. */
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });

  const imported: any = {
    title: 'Imported, sourced to the file', template: 'chronological', design: 'classic',
    personal: { fullName: 'Jeanky Mendez', email: 'jm@example.ph' },
    education: [{ school: 'HAU', degree: 'BSIT', level: 'bachelor', year: '2024' }],
    experience: [], skills: ['JavaScript', 'Git'],
  };
  const made = await seeker('resumes/save', { resume: imported });
  assert.equal(made.body.ok, true);
  const id = made.body.resume.id;

  // Before the file exists, its name is not a source — the row has none.
  const early = { ...made.body.resume, skillEvidence: { JavaScript: { kind: 'document', ref: 'Mendez_Resume.pdf' } } };
  const rejected = await seeker('resumes/save', { resume: early });
  assert.equal(rejected.body.ok, true, 'the save still succeeds — only the unbacked source is dropped');
  assert.deepEqual(rejected.body.resume.skillEvidence, {},
    'a document source naming a file the resume does not hold must not be stored');

  // Attach the real thing. A minimal but genuine PDF: the route sniffs the
  // leading bytes and refuses anything whose contents contradict its type.
  const form = new FormData();
  form.append('resume_id', String(id));
  form.append('file', new Blob([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n')], { type: 'application/pdf' }),
              'Mendez_Resume.pdf');
  const up = await seeker.upload('resumes/upload', form);
  assert.equal(up.body.ok, true, up.body.error);
  assert.equal(up.body.ownFile.name, 'Mendez_Resume.pdf');

  // Now the same source is accepted, under the name the applicant sees.
  const withFile = (await seeker('resumes/get', { id })).body.resume;
  withFile.skillEvidence = {
    JavaScript: { kind: 'document', ref: 'Mendez_Resume.pdf' },
    Git: { kind: 'document', ref: 'Mendez_Resume.pdf' },
  };
  const linked = await seeker('resumes/save', { resume: withFile });
  assert.equal(linked.body.ok, true);
  assert.deepEqual(linked.body.resume.skillEvidence, {
    JavaScript: [{ kind: 'document', ref: 'Mendez_Resume.pdf' }],
    Git: [{ kind: 'document', ref: 'Mendez_Resume.pdf' }],
  });

  // And a different file name is still refused, so the kind is not a bypass.
  withFile.skillEvidence = { JavaScript: { kind: 'document', ref: 'Someone_Else.pdf' } };
  const wrongName = await seeker('resumes/save', { resume: withFile });
  assert.deepEqual(wrongName.body.resume.skillEvidence, {},
    'only the file actually attached to THIS resume is a source');
});

test('a recruiter can put part of the score on certifications, over HTTP', async () => {
  /* The end-to-end version of the engine tests: the four weights survive the
     round trip through Postgres, the required certifications come back with
     the opening, and the CHECK constraint on the table agrees with the
     validation in the route. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const made = await hr('postings/save', {
    posting: {
      title: 'Network Engineer', department: 'Information Technology',
      employmentType: 'full-time', description: 'Maintain the client network estate.',
      educationLevel: 'bachelor', minExperienceMonths: 0, skills: ['Networking'],
      certifications: ['CCNA', 'c.c.n.a.'],   // the second is the same requirement
      weights: { skills: 40, education: 20, experience: 20, certifications: 20 },
    },
  });
  assert.equal(made.body.ok, true, made.body.error);
  assert.deepEqual(made.body.posting.weights,
    { skills: 40, education: 20, experience: 20, certifications: 20,
      projects: 0, languages: 0, references: 0, relevance: 0, field: 0 });
  assert.deepEqual(made.body.posting.certifications, ['CCNA'],
    'the duplicate is dropped on the normalised form, so the component can be scored out of 1');

  // Weights that do not total 100 once certifications are counted are refused.
  const bad = await hr('postings/save', {
    posting: {
      title: 'Bad weights', department: 'Information Technology',
      employmentType: 'full-time', description: 'Should never be stored.',
      educationLevel: 'bachelor', minExperienceMonths: 0, skills: ['Networking'],
      weights: { skills: 50, education: 25, experience: 25, certifications: 20 },
    },
  });
  assert.equal(bad.body.ok, false, 'the four weights must total 100, not the three');
  assert.match(String(bad.body.error), /add up to 100/);

  // And the three original components still cannot be switched off.
  const off = await hr('postings/save', {
    posting: {
      title: 'Zeroed education', department: 'Information Technology',
      employmentType: 'full-time', description: 'Should never be stored.',
      educationLevel: 'bachelor', minExperienceMonths: 0, skills: ['Networking'],
      weights: { skills: 60, education: 0, experience: 20, certifications: 20 },
    },
  });
  assert.equal(off.body.ok, false);
  assert.match(String(off.body.error), /at least 10%/);
});

test('an opening can ask its own questions, and they must be answered to apply', async () => {
  /* THE RECRUITER'S SCREENING QUESTIONS, end to end. What matters here is
     that "mandatory" is a rule the SERVER keeps, not a courtesy the apply
     screen extends: the questions are read from the database, so a client
     that simply sends no answers is refused rather than obeyed. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const made = await hr('postings/save', {
    posting: {
      title: 'Screened Support Role', department: 'Information Technology',
      employmentType: 'full-time', description: 'A role used to check screening questions.',
      educationLevel: 'none', minExperienceMonths: 0, skills: ['Communication'],
      questions: [{ prompt: 'How soon can you start?' }, { prompt: 'Are you willing to work on site?' }],
    },
  });
  assert.equal(made.body.ok, true, made.body.error);
  const posting = made.body.posting;
  assert.equal(posting.questions.length, 2);
  assert.deepEqual(posting.questions.map((q: any) => q.prompt),
    ['How soon can you start?', 'Are you willing to work on site?'],
    'the questions come back in the order the recruiter wrote them');

  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const rid = (await seeker('resumes/list')).body.resumes[0].id;

  // No answers at all.
  const none = await seeker('applications/apply', { resumeId: rid, postingId: posting.id });
  assert.equal(none.body.ok, false, 'an unanswered question must stop the application');
  assert.match(String(none.body.error), /How soon can you start\?/,
    'the refusal names the question, so the applicant knows which one to go back to');

  // One answered, one blank — still refused, and it names the blank one.
  const half = await seeker('applications/apply', {
    resumeId: rid, postingId: posting.id,
    answers: [{ questionId: posting.questions[0].id, answer: 'Two weeks' },
              { questionId: posting.questions[1].id, answer: '   ' }],
  });
  assert.equal(half.body.ok, false);
  assert.match(String(half.body.error), /willing to work on site/);

  // Both answered: accepted, and the recruiter reads them beside the resume.
  const done = await seeker('applications/apply', {
    resumeId: rid, postingId: posting.id,
    answers: [{ questionId: posting.questions[0].id, answer: 'Two weeks' },
              { questionId: posting.questions[1].id, answer: 'Yes, three days a week' }],
  });
  assert.equal(done.body.ok, true, done.body.error);

  const ranked = await hr('applications/ranked', { postingId: posting.id });
  const row = ranked.body.rows.find((r: any) => r.resume?.id === rid);
  assert.ok(row, 'the applicant must be on the list');
  /* The PROMPT is asserted, not only the answer. The recruiter's panel renders
     a.prompt above a.answer, so an answer that arrives without its question is
     a line of text on screen with nothing saying what was asked — which is
     exactly what shipped when this route emitted `question` instead. */
  assert.deepEqual(row.answers.map((a: any) => [a.prompt, a.answer]), [
    ['How soon can you start?', 'Two weeks'],
    ['Are you willing to work on site?', 'Yes, three days a week'],
  ], 'each answer arrives beside the question it answers, in the recruiter’s own order');
  assert.ok(row.answers.every((a: any) => a.questionId),
    'each answer names the question it belongs to');

  // And the answers are not part of the score: nothing about them can move it.
  assert.equal(typeof row.score, 'number');
});

test('an opening with no questions still accepts a plain application', async () => {
  /* The guard above must not become a tax on every other opening. Most
     openings ask nothing, and applying to one has to stay a single call with
     no answers in it. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const made = await hr('postings/save', {
    posting: {
      title: 'Unscreened Role', department: 'Information Technology',
      employmentType: 'full-time', description: 'A role that asks no questions at all.',
      educationLevel: 'none', minExperienceMonths: 0, skills: ['Communication'],
    },
  });
  assert.equal(made.body.ok, true, made.body.error);
  assert.deepEqual(made.body.posting.questions, []);

  const seeker = client();
  await seeker('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const rid = (await seeker('resumes/list')).body.resumes[0].id;
  const res = await seeker('applications/apply', { resumeId: rid, postingId: made.body.posting.id });
  assert.equal(res.body.ok, true, res.body.error);
});

test('private links reach the recruiter and never the resume the engine scores', async () => {
  /* The applicant's portfolio and certificate URLs are deliberately kept OFF
     the document — that is the whole point of the feature — while still
     reaching the person doing the screening. Two things are checked: they
     survive the round trip, and they change no score. */
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const before = (await seeker('resumes/list')).body.resumes[0];

  const saved = await seeker('resumes/save', {
    resume: {
      ...before,
      links: [
        { label: 'Portfolio', url: 'https://example.ph/portfolio' },
        { label: 'Bad', url: 'javascript:alert(1)' },      // never stored
        { label: 'Relative', url: '/not-a-real-address' }, // never stored
      ],
    },
  });
  assert.equal(saved.body.ok, true, saved.body.error);
  assert.deepEqual(saved.body.resume.links, [{ url: 'https://example.ph/portfolio', label: 'Portfolio' }],
    'only http(s) addresses are kept — a javascript: URL would run in the recruiter’s browser');

  // The link is not a resume section, so it cannot move a score.
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const pid = (await hr('postings/mine')).body.postings[0].id;
  const withLink = await seeker('match/score', { resumeId: before.id, postingId: pid });
  const stripped = await seeker('resumes/save', { resume: { ...before, links: [] } });
  assert.equal(stripped.body.ok, true);
  const withoutLink = await seeker('match/score', { resumeId: before.id, postingId: pid });
  assert.equal(withLink.body.score, withoutLink.body.score,
    'adding or removing a link must not change the score by a single point');
});

test('a section the applicant switches off leaves the resume and the score', async () => {
  /* HIDING IS ONE DECISION WITH TWO CONSEQUENCES. A hidden section is left
     off the document AND out of the score, so the number a recruiter reads
     always describes the sheet in front of them. A hidden section that still
     scored would be marks awarded for something they will never see. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const made = await hr('postings/save', {
    posting: {
      title: 'Certified Role', department: 'Information Technology',
      employmentType: 'full-time', description: 'A role that puts part of the score on certificates.',
      educationLevel: 'none', minExperienceMonths: 0, skills: ['Communication'],
      certifications: ['CCNA'],
      weights: { skills: 40, education: 20, experience: 20, certifications: 20 },
    },
  });
  assert.equal(made.body.ok, true, made.body.error);
  const pid = made.body.posting.id;

  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const base = (await seeker('resumes/list')).body.resumes[0];

  const shown = await seeker('resumes/save', {
    resume: { ...base, certifications: [{ name: 'CCNA', year: '2024' }], hiddenSections: [] },
  });
  assert.equal(shown.body.ok, true, shown.body.error);
  const scoredShown = await seeker('match/score', { resumeId: base.id, postingId: pid });
  assert.equal(scoredShown.body.matchedCertifications.length, 1, 'the certificate counts while it is shown');

  const hidden = await seeker('resumes/save', {
    resume: { ...base, certifications: [{ name: 'CCNA', year: '2024' }], hiddenSections: ['certifications'] },
  });
  assert.equal(hidden.body.ok, true, hidden.body.error);
  assert.deepEqual(hidden.body.resume.hiddenSections, ['certifications']);
  assert.equal(hidden.body.resume.certifications.length, 1,
    'the contents are KEPT — this is a switch, not a delete, and the builder has to be able to show it again');

  const scoredHidden = await seeker('match/score', { resumeId: base.id, postingId: pid });
  assert.equal(scoredHidden.body.matchedCertifications.length, 0,
    'a section nobody will see must not earn marks');
  assert.ok(scoredHidden.body.score < scoredShown.body.score,
    `hiding a scored section must lower the score, got ${scoredHidden.body.score} vs ${scoredShown.body.score}`);

  // And the recruiter never receives the hidden content at all.
  const applied = await seeker('applications/apply', { resumeId: base.id, postingId: pid });
  assert.equal(applied.body.ok, true, applied.body.error);
  const ranked = await hr('applications/ranked', { postingId: pid });
  const row = ranked.body.rows.find((r: any) => r.resume?.id === base.id);
  assert.ok(row, 'the applicant must be on the list');
  assert.equal(row.resume.certifications, undefined,
    'the hidden section must not reach the recruiter’s screen, not even unrendered in the payload');

  // Put it back, so the ordering of tests in this file cannot matter.
  await seeker('resumes/save', { resume: { ...base, hiddenSections: [] } });
});

test('the three scored components cannot be switched off by a hand-written request', async () => {
  /* parseHiddenSections keeps only the six names it knows. Education,
     experience and skills are not among them: they are what every opening
     scores, and a sheet without them is not a resume. The UI never offers
     them, and this proves the UI is not the only thing stopping it. */
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const base = (await seeker('resumes/list')).body.resumes[0];

  const res = await seeker('resumes/save', {
    resume: { ...base, hiddenSections: ['skills', 'education', 'experience', 'projects', 'nonsense'] },
  });
  assert.equal(res.body.ok, true, res.body.error);
  assert.deepEqual(res.body.resume.hiddenSections, ['projects'],
    'only the hideable name survives; the three scored ones and the invented one are dropped');
  assert.ok(res.body.resume.skills.length > 0, 'skills are still on the resume');

  await seeker('resumes/save', { resume: { ...base, hiddenSections: [] } });
});

test('a recruiter can score projects, languages and references too', async () => {
  /* The three components added alongside certifications. Languages are
     matched by name the way certificates are; projects and references are
     counted against a stated minimum, the way experience is. */
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const made = await hr('postings/save', {
    posting: {
      title: 'Seven Component Role', department: 'Information Technology',
      employmentType: 'full-time', description: 'A role that scores every section it can.',
      educationLevel: 'none', minExperienceMonths: 0, skills: ['Communication'],
      languages: ['Filipino', 'filipino'],   // the second is the same requirement
      minProjects: 2, minReferences: 1,
      weights: { skills: 40, education: 10, experience: 10, certifications: 10, projects: 10, languages: 10, references: 10 },
    },
  });
  assert.equal(made.body.ok, true, made.body.error);
  const p = made.body.posting;
  assert.deepEqual(p.weights,
    { skills: 40, education: 10, experience: 10, certifications: 10, projects: 10, languages: 10, references: 10, relevance: 0, field: 0 });
  assert.deepEqual(p.languages, ['Filipino'], 'the duplicate is folded, so the component can be scored out of 1');
  assert.equal(p.minProjects, 2);
  assert.equal(p.minReferences, 1);

  // They survive the round trip rather than only existing in the response.
  const back = await hr('postings/get', { id: p.id });
  assert.equal(back.body.posting.minProjects, 2);
  assert.deepEqual(back.body.posting.languages, ['Filipino']);

  const seeker = client();
  await seeker('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const base = (await seeker('resumes/list')).body.resumes[0];
  await seeker('resumes/save', {
    resume: {
      ...base,
      projects: [{ name: 'Barangay records system' }, { name: 'Capstone' }],
      languages: [{ name: 'Filipino', proficiency: 'Native' }],
      references: [{ name: 'Engr. Maria Santos' }],
    },
  });

  const s = await seeker('match/score', { resumeId: base.id, postingId: p.id });
  assert.equal(s.body.ok, true, s.body.error);
  assert.deepEqual(s.body.matchedLanguages, ['Filipino']);
  assert.deepEqual(s.body.missingLanguages, []);
  assert.equal(s.body.projectCount, 2);
  assert.equal(s.body.minProjects, 2);
  assert.equal(s.body.referenceCount, 1);
  assert.equal(s.body.minReferences, 1);
  assert.deepEqual(s.body.weights,
    { skills: 0.4, education: 0.1, experience: 0.1, certifications: 0.1, projects: 0.1, languages: 0.1, references: 0.1, relevance: 0, field: 0 },
    'the split it reports is the split it used');
});

// ---------- the admin level belongs to the partner company's head of recruitment ----------

test("the head of recruitment sees and decides only their own company's requests", async () => {
  psql(['-c', "INSERT INTO companies (company_id, company_name) VALUES (902, 'Other Partner Inc.') ON CONFLICT DO NOTHING"], DB);
  psql(['-c', `INSERT INTO recruiter_requests (first_name, last_name, email, position_title, company_id, status) VALUES
     ('Own', 'Company', 'own.req@clark.test', 'Recruiter', 1, 'pending'),
     ('Other', 'Company', 'other.req@other.test', 'Recruiter', 902, 'pending')`], DB);
  const head = client();
  await head('auth/login', { email: 'admin@demo.ph', password: 'demo123' });

  const emails = (await head('admin/requests')).body.requests.map((r: any) => r.email);
  assert.ok(emails.includes('own.req@clark.test'), 'their own company\'s request must be listed');
  assert.ok(!emails.includes('other.req@other.test'), 'another company\'s request must not be listed');

  const otherId = Number(psql(['-tAc', "SELECT request_id FROM recruiter_requests WHERE email = 'other.req@other.test'"], DB).trim());
  assert.equal((await head('admin/approve', { id: otherId })).body.ok, false, 'approving another company\'s request');
  assert.equal((await head('admin/decline', { id: otherId })).body.ok, false, 'declining another company\'s request');
  assert.equal(psql(['-tAc', `SELECT status FROM recruiter_requests WHERE request_id = ${otherId}`], DB).trim(), 'pending');

  assert.equal((await head('admin/assign-department', { companyId: 902, department: 'IT', userId: null })).status, 403);
  const recs = (await head('admin/recruiters')).body.recruiters;
  assert.ok(recs.length && recs.every((r: any) => r.companyName === 'Clark Outsourcing'), 'only their own recruiters');
});

test('an admin with no company — the old research-team admin — is refused everywhere', async () => {
  psql(['-c', `INSERT INTO users (role, first_name, last_name, email, password_hash, verified)
     SELECT 'admin', 'Research', 'Team', 'research.old@demo.ph', password_hash, 1 FROM users WHERE email = 'admin@demo.ph'`], DB);
  const old = client();
  await old('auth/login', { email: 'research.old@demo.ph', password: 'demo123' });
  for (const route of ['admin/requests', 'admin/recruiters', 'admin/dept-assignments', 'metrics/summary']) {
    const r = await old(route);
    assert.equal(r.status, 403, route);
    assert.match(r.body.error, /head of recruitment/, route);
  }
});

// ---------- resume names and the resume limit ----------

test('the database itself refuses a second resume with the same name', () => {
  // Not through the API: straight at the table, differently cased and padded,
  // to show the rule does not depend on the route remembering to check.
  assert.throws(
    () => psql(['-c', "INSERT INTO resumes (user_id, title) SELECT user_id, '  ' || UPPER(title) || '  ' FROM resumes ORDER BY resume_id LIMIT 1"], DB),
    /resumes_user_title_unique/,
  );
});

test('an applicant can keep 20 resumes, and no more', async () => {
  const c = client();
  await c('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const draft = (title: string, id?: string) => ({ resume: {
    ...(id ? { id } : {}), title, template: 'chronological', design: 'classic',
    personal: { fullName: 'Marco Garcia', email: 'marco@demo.ph', phone: '0917', address: '', summary: 'Two plain sentences.' },
    education: [{ school: 'HAU', degree: 'BS Business Administration', level: 'bachelor', year: '2025' }],
    experience: [], skills: ['Teamwork'], certifications: [],
  } });
  let have = (await c('resumes/list')).body.resumes.length;
  for (let n = 1; have < 20; n++, have++) assert.equal((await c('resumes/save', draft(`Limit ${n}`))).body.ok, true);

  const over = await c('resumes/save', draft('The twenty-first'));
  assert.equal(over.body.ok, false);
  assert.match(over.body.error, /20 resumes/);
  assert.equal((await c('resumes/duplicate', { id: (await c('resumes/list')).body.resumes[0].id })).body.ok, false, 'a copy is a new resume');

  const one = (await c('resumes/list')).body.resumes.find((r: any) => r.title === 'Limit 1');
  assert.equal((await c('resumes/save', draft('Limit 1, edited', one.id))).body.ok, true, 'editing still works at the limit');
  assert.equal((await c('resumes/list')).body.resumes.length, 20);
});

// ---------- pay, shift, work setup, location, and the number of openings ----------

test('an opening can state pay, shift, setup, location and openings, and clear them again', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const base = {
    title: 'Facts Test Role', department: 'Customer Support', employmentType: 'full-time',
    description: 'A role used to check the stated facts about a job.', skills: ['Customer Service'],
    educationLevel: 'highschool', minExperienceMonths: 0,
  };
  const made = await hr('postings/save', { posting: {
    ...base, salaryMin: '18,000', salaryMax: 22000, shift: 'night', workSetup: 'onsite',
    workLocation: '  Clark Freeport Zone, Pampanga  ', vacancies: '10',
  } });
  assert.equal(made.body.ok, true, made.body.error);
  const p = made.body.posting;
  assert.equal(p.salaryMin, 18000, '"18,000" is read as 18000, not refused and not 18');
  assert.equal(p.salaryMax, 22000);
  assert.equal(p.shift, 'night');
  assert.equal(p.workSetup, 'onsite');
  assert.equal(p.workLocation, 'Clark Freeport Zone, Pampanga');
  assert.equal(p.vacancies, 10);
  assert.equal(p.filled, 0);

  // Anyone browsing sees the same facts.
  const pub = (await client()('postings/list')).body.postings.find((x: any) => x.id === p.id);
  assert.equal(pub.salaryMin, 18000);
  assert.equal(pub.shift, 'night');

  // Clearing a field clears it — no leftover value, and no key at all.
  const cleared = (await hr('postings/save', { posting: { ...base, id: p.id } })).body.posting;
  for (const k of ['salaryMin', 'salaryMax', 'shift', 'workSetup', 'workLocation', 'vacancies', 'filled']) {
    assert.equal(k in cleared, false, `${k} should be gone once cleared`);
  }
});

test('a wrong salary or number of openings is refused, not silently dropped', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const base = {
    title: 'Refusal Test Role', department: 'Customer Support', description: 'A role used to check refusals.',
    skills: ['Customer Service'], educationLevel: 'highschool', minExperienceMonths: 0,
  };
  const refused = async (extra: any, why: RegExp, label: string) => {
    const r = await hr('postings/save', { posting: { ...base, ...extra } });
    assert.equal(r.body.ok, false, label);
    assert.match(r.body.error, why, label);
  };
  await refused({ salaryMin: 'about 20k' }, /whole number of pesos/, 'words for a salary');
  await refused({ salaryMin: -5 }, /whole number of pesos/, 'a negative salary');
  await refused({ salaryMin: 25000, salaryMax: 18000 }, /can't be below/, 'a range upside down');
  await refused({ vacancies: 0 }, /from 1 to 999/, 'zero openings');
  await refused({ vacancies: 2.5 }, /from 1 to 999/, 'half an opening');
  // An unknown shift or setup is "not stated", like an unknown design elsewhere.
  const ok = await hr('postings/save', { posting: { ...base, shift: 'graveyard', workSetup: 'moon' } });
  assert.equal(ok.body.ok, true);
  assert.equal('shift' in ok.body.posting, false);
});

test('an opening closes itself when its last opening is filled, and only then', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const made = (await hr('postings/save', { posting: {
    title: 'Two Seats Role', department: 'Customer Support', description: 'Hiring exactly two people for this.',
    skills: ['Customer Service'], educationLevel: 'highschool', minExperienceMonths: 0, vacancies: 2,
  } })).body.posting;

  const apply = async (email: string) => {
    const c = client();
    await c('auth/login', { email, password: 'demo123' });
    const rid = (await c('resumes/list')).body.resumes[0].id;
    const r = await c('applications/apply', { resumeId: rid, postingId: made.id });
    assert.equal(r.body.ok, true, `${email}: ${r.body.error}`);
    return r.body.application.id;
  };
  const a1 = await apply('ana@demo.ph');
  const a2 = await apply('liza@demo.ph');

  const first = await hr('applications/set-status', { id: a1, status: 'hired' });
  assert.equal(first.body.ok, true);
  assert.equal(first.body.postingClosed, undefined, 'one of two filled: still open');
  let p = (await hr('postings/get', { id: made.id })).body.posting;
  assert.equal(p.status, 'open');
  assert.equal(p.filled, 1);

  const second = await hr('applications/set-status', { id: a2, status: 'hired' });
  assert.equal(second.body.postingClosed, true, 'the last seat closes it');
  p = (await hr('postings/get', { id: made.id })).body.posting;
  assert.equal(p.status, 'closed');
  assert.equal(p.filled, 2);
  const pub = (await client()('postings/list')).body.postings.some((x: any) => x.id === made.id);
  assert.equal(pub, false, 'a filled opening leaves the public list');

  // Moving a hire back is a correction; it never reopens the opening by itself.
  await hr('applications/set-status', { id: a2, status: 'offer' });
  assert.equal((await hr('postings/get', { id: made.id })).body.posting.status, 'closed');
});

test('an opening that states no number never closes by itself', async () => {
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const made = (await hr('postings/save', { posting: {
    title: 'Open-Ended Role', department: 'Customer Support', description: 'No number of openings stated here.',
    skills: ['Customer Service'], educationLevel: 'highschool', minExperienceMonths: 0,
  } })).body.posting;
  const c = client();
  await c('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const rid = (await c('resumes/list')).body.resumes[0].id;
  const app = (await c('applications/apply', { resumeId: rid, postingId: made.id })).body.application;
  const hired = await hr('applications/set-status', { id: app.id, status: 'hired' });
  assert.equal(hired.body.postingClosed, undefined);
  assert.equal((await hr('postings/get', { id: made.id })).body.posting.status, 'open');
});
