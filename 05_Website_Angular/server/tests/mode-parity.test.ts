/* ============================================================
   MODE PARITY TESTS
   ------------------------------------------------------------
   The app ships in two modes and they are NOT two builds of the
   same code: demo mode is a separate hand-written implementation
   (client/src/app/core/demo-adapter.ts) that runs entirely in the
   browser, while api mode is the Express server on PostgreSQL.

   Demo mode is what gets demonstrated — at the defense, and to the
   partner company. Api mode is what real applicants would use. A
   rule enforced in one and not the other is therefore worse than an
   ordinary bug: it makes the demonstration a misrepresentation of
   the system. Nothing else in the suite compares the two.

   This boots the real server against a throwaway database AND runs
   the demo adapter in-process behind storage shims, then drives the
   SAME operations through both and asserts they agree — first on
   accept/reject, then on the actual values (scores, tiers, recorded
   history), because agreeing to accept while disagreeing about the
   number shown is the failure that would matter most here.

     cd server && npm run test:parity
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import path from 'node:path';

/* ---- browser storage shims, installed BEFORE the adapter is imported ----
   The demo adapter keeps its DATABASE in localStorage but its SESSION in
   sessionStorage, and swallows storage errors. Shimming only localStorage
   makes every call run as a signed-out user while login still appears to
   succeed — which silently turns this whole file into a comparison of
   anonymous requests that trivially "agree". */
function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
(globalThis as any).localStorage = memStorage();
(globalThis as any).sessionStorage = memStorage();

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { DemoAdapter } from '../../client/src/app/core/demo-adapter';

const DB = process.env.TEST_DB_NAME || 'resumematch_paritytest';
const PORT = Number(process.env.TEST_PORT || 4398);
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

function httpClient() {
  let cookie = '';
  return async function call(route: string, body: any = {}): Promise<any> {
    const res = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    return await res.json().catch(() => ({ ok: false, error: 'unparseable' }));
  };
}

let demo: DemoAdapter;
let api: ReturnType<typeof httpClient>;

before(async () => {
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
        PORT: String(PORT), SESSION_SECRET: 'parity-test-secret', DEBUG: 'true',
        SMTP_HOST: '', GEMINI_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

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

  demo = new DemoAdapter();
  api = httpClient();
});

after(() => {
  server?.kill('SIGKILL');
  try { psql(['-c', `DROP DATABASE IF EXISTS ${DB}`]); } catch { /* best effort */ }
});

/** Both modes must agree on whether an operation is allowed. */
async function agree(label: string, d: Promise<any>, a: Promise<any>): Promise<void> {
  const [dr, ar] = await Promise.all([d, a]);
  assert.equal(
    !!dr?.ok, !!ar?.ok,
    `${label}: demo ok=${!!dr?.ok} (${dr?.error ?? ''}) but api ok=${!!ar?.ok} (${ar?.error ?? ''})`,
  );
}

/* This guard exists because the first version of this file passed while the
   session shim was broken and every call ran anonymously. If sign-in does not
   actually take effect in BOTH modes, everything below is meaningless. */
test('the harness is really signed in on both sides', async () => {
  const d: any = await demo.auth.login('marco@demo.ph', 'demo123');
  const a: any = await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  assert.equal(d.ok, true);
  assert.equal(a.ok, true);
  const dMine: any = await demo.applications.mine();
  const aMine: any = await api('applications/mine');
  assert.equal(dMine.ok, true, 'demo session did not take effect');
  assert.equal(aMine.ok, true, 'api session did not take effect');
  assert.ok(dMine.applications.length > 0, 'demo seed should give this seeker applications');
  assert.ok(aMine.applications.length > 0, 'sql seed should give this seeker applications');
});

test('authentication is refused and accepted identically', async () => {
  await agree('wrong password',
    demo.auth.login('marco@demo.ph', 'nope'),
    api('auth/login', { email: 'marco@demo.ph', password: 'nope' }));
  await agree('unknown email',
    demo.auth.login('nobody@nowhere.ph', 'demo123'),
    api('auth/login', { email: 'nobody@nowhere.ph', password: 'demo123' }));
  await agree('email is matched case-insensitively',
    demo.auth.login('MARCO@DEMO.PH', 'demo123'),
    api('auth/login', { email: 'MARCO@DEMO.PH', password: 'demo123' }));
});

test('role guards are enforced in both modes', async () => {
  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });

  await agree('seeker → postings.mine', demo.postings.mine(), api('postings/mine'));
  await agree('seeker → stats.hr', demo.stats.hr(), api('stats/hr'));
  await agree('seeker → admin.requests', demo.admin.requests(), api('admin/requests'));
  await agree('seeker → metrics.summary', demo.metrics.summary(), api('metrics/summary'));
});

test('ownership rules are enforced in both modes', async () => {
  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });

  await agree("another seeker's resume", demo.resumes.get('r1'), api('resumes/get', { id: 1 }));
  await agree('a resume id that does not exist', demo.resumes.get('r999999'), api('resumes/get', { id: 999999 }));
  await agree('history for an application that does not exist',
    demo.applications.history('a999999'), api('applications/history', { id: 999999 }));
});

test('the same résumé scores identically against every seeded opening', async () => {
  // The study's central claim is the number itself. Agreeing to accept while
  // disagreeing about the score would be the worst of the possible failures.
  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });

  const dP: any = await demo.postings.open();
  const aP: any = await api('postings/list');
  const dR: any = await demo.resumes.mine();
  const aR: any = await api('resumes/list');
  assert.ok(dP.postings.length && aP.postings.length, 'both modes must list openings');

  const dResume = dR.resumes[0];
  const aResume = aR.resumes.find((r: any) => r.title === dResume.title) ?? aR.resumes[0];

  // Pair by TITLE — the two seeds use different id schemes ('p1' vs 1).
  for (const dPost of dP.postings) {
    const aPost = aP.postings.find((p: any) => p.title === dPost.title);
    assert.ok(aPost, `posting "${dPost.title}" exists in demo mode but not in api mode`);

    const d: any = await demo.match.score(dResume.id, dPost.id);
    const a: any = await api('match/score', { resumeId: aResume.id, postingId: aPost.id });

    assert.equal(d.score, a.score, `score differs for "${dPost.title}"`);
    assert.equal(d.tier, a.tier, `tier differs for "${dPost.title}"`);
    assert.equal(d.eduMeets, a.eduMeets, `education verdict differs for "${dPost.title}"`);
    assert.equal(d.expMeets, a.expMeets, `experience verdict differs for "${dPost.title}"`);
    assert.deepEqual([...d.matchedSkills].sort(), [...a.matchedSkills].sort(),
      `matched skills differ for "${dPost.title}"`);
  }
});

test('recommendation tiers hold the same number of openings', async () => {
  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const d: any = await demo.match.recommendations();
  const a: any = await api('match/recommendations');
  assert.equal(d.strong.length, a.strong.length, 'strong tier size differs');
  assert.equal(d.possible.length, a.possible.length, 'possible tier size differs');
  assert.equal(d.related.length, a.related.length, 'related tier size differs');
});

test('the applicant sees the same recorded history in both modes', async () => {
  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const dApps: any = await demo.applications.mine();
  const aApps: any = await api('applications/mine');
  assert.equal(dApps.applications.length, aApps.applications.length, 'application count differs');

  for (const dApp of dApps.applications) {
    const aApp = aApps.applications.find((x: any) => x.posting?.title === dApp.posting?.title);
    assert.ok(aApp, `application for "${dApp.posting?.title}" missing in api mode`);
    assert.equal(dApp.status, aApp.status, `status differs for "${dApp.posting?.title}"`);

    const dH: any = await demo.applications.history(dApp.id);
    const aH: any = await api('applications/history', { id: aApp.id });
    const shape = (r: any) => r.events.map((e: any) => `${e.from ?? '-'}>${e.to}/${e.by}`);
    assert.deepEqual(shape(dH), shape(aH), `history differs for "${dApp.posting?.title}"`);

    // And neither mode may name an individual to the applicant.
    for (const e of [...dH.events, ...aH.events]) {
      assert.ok(!('byName' in e), 'an applicant must never be told who made the change');
    }
  }
});

test('a recruiter is told which colleague acted, in both modes', async () => {
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const dP: any = await demo.postings.mine();
  const aP: any = await api('postings/mine');

  // Find a posting whose applicant has an employer-side move in BOTH modes.
  let checked = 0;
  for (const dPost of dP.postings) {
    const aPost = aP.postings.find((p: any) => p.title === dPost.title);
    if (!aPost) continue;
    const dRanked: any = await demo.applications.ranked(dPost.id);
    const aRanked: any = await api('applications/ranked', { postingId: aPost.id });
    if (!dRanked.ok || !aRanked.ok || !dRanked.rows.length || !aRanked.rows.length) continue;

    const dH: any = await demo.applications.history(dRanked.rows[0].application.id);
    const aH: any = await api('applications/history', { id: aRanked.rows[0].application.id });
    const dNamed = dH.events.filter((e: any) => e.by === 'employer' && e.byName);
    const aNamed = aH.events.filter((e: any) => e.by === 'employer' && e.byName);
    if (!dNamed.length && !aNamed.length) continue;

    assert.ok(dNamed.length > 0, `demo mode named nobody for "${dPost.title}" but api mode did`);
    assert.ok(aNamed.length > 0, `api mode named nobody for "${dPost.title}" but demo mode did`);
    checked++;
  }
  assert.ok(checked > 0, 'the seeds should give at least one applicant an employer-side move');
});

test('recruiter-side rules are enforced identically', async () => {
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const dP: any = await demo.postings.mine();
  const aP: any = await api('postings/mine');

  /* Find a posting that HAS an applicant in both modes. The first version of
     this test took postings[0] and wrapped the checks in `if (dId && aId)`,
     so when that posting had no applicants every assertion was skipped and
     the test passed green — it stayed green even with a deliberate 2000 vs
     9000 divergence planted in the demo adapter. A test that cannot fail is
     worse than no test, so this now searches, and asserts that it found one. */
  let dId: string | undefined;
  let aId: string | undefined;
  for (const dPost of dP.postings) {
    const aPost = aP.postings.find((p: any) => p.title === dPost.title);
    if (!aPost) continue;
    const dRanked: any = await demo.applications.ranked(dPost.id);
    const aRanked: any = await api('applications/ranked', { postingId: aPost.id });
    if (!dRanked.ok || !aRanked.ok) continue;
    const d = dRanked.rows.find((r: any) => r.application.status !== 'withdrawn');
    const a = aRanked.rows.find((r: any) => r.application.status !== 'withdrawn');
    if (d && a) { dId = d.application.id; aId = a.application.id; break; }
  }
  assert.ok(dId && aId, 'the seeds must give at least one posting a live applicant in both modes');

  await agree('an unknown status',
    demo.applications.setStatus(dId!, 'banana'), api('applications/set-status', { id: aId, status: 'banana' }));
  await agree("setting withdrawn (the applicant's state)",
    demo.applications.setStatus(dId!, 'withdrawn'), api('applications/set-status', { id: aId, status: 'withdrawn' }));
  await agree('a recruiter withdrawing an application',
    demo.applications.withdraw(dId!), api('applications/withdraw', { id: aId }));
  await agree('a message under the minimum length',
    demo.applications.invite(dId!, 'hi'), api('applications/invite', { id: aId, message: 'hi' }));
  await agree('a message over 2000 characters',
    demo.applications.invite(dId!, 'x'.repeat(2500)), api('applications/invite', { id: aId, message: 'x'.repeat(2500) }));

  await agree('a posting with a deadline in the past',
    demo.postings.save({ title: 'Parity', department: 'IT', description: 'A parity check posting.', skills: ['HTML/CSS'], educationLevel: 'bachelor', minExperienceMonths: 0, deadline: '2000-01-01' } as any),
    api('postings/save', { posting: { title: 'Parity', department: 'IT', description: 'A parity check posting.', skills: ['HTML/CSS'], educationLevel: 'bachelor', minExperienceMonths: 0, deadline: '2000-01-01' } }));

  await agree('a posting with an empty title',
    demo.postings.save({ title: '', department: 'IT', description: 'x', skills: [], educationLevel: 'bachelor' } as any),
    api('postings/save', { posting: { title: '', department: 'IT', description: 'x', skills: [], educationLevel: 'bachelor' } }));
});

test('the password policy is the same in both modes', async () => {
  await demo.auth.login('liza@demo.ph', 'demo123');
  await api('auth/login', { email: 'liza@demo.ph', password: 'demo123' });

  for (const pw of ['short', 'alllowercase', '12345678']) {
    await agree(`password "${pw}"`,
      demo.auth.changePassword('demo123', pw),
      api('auth/change-password', { current: 'demo123', next: pw }));
  }
  // and a compliant one is accepted by both
  await agree('a compliant password',
    demo.auth.changePassword('demo123', 'goodpass1'),
    api('auth/change-password', { current: 'demo123', next: 'goodpass1' }));
});
