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

const DB = process.env.TEST_DB_NAME || 'linaw_paritytest';
const PORT = Number(process.env.TEST_PORT || 4398);
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

/* The optional sections (projects, languages, references) and the extra
   fields on the existing ones are stored one way in Postgres and another in
   the browser. What must agree is what comes BACK: the same keys, the same
   values, and — the part that is easy to get wrong — nothing at all where a
   section is empty, because an empty array is truthy in a template and would
   print a heading with no content under it. */
test('the optional sections round-trip identically in both modes', async () => {
  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });

  const payload = (id: string | number | null) => ({
    id,
    title: 'Parity — optional sections',
    template: 'chronological',
    design: 'technical',
    personal: {
      fullName: 'Marco Garcia', email: 'marco@demo.ph', phone: '0917 222 2222', address: 'Angeles City',
      summary: 'A resume built by the parity suite.',
      headline: 'Hospitality Management graduate',
      linkedin: 'linkedin.com/in/marcogarcia',
      portfolio: '',                       // blank must come back ABSENT, not ''
    },
    education: [{ school: 'Holy Angel University', degree: 'BS Hospitality Management', level: 'bachelor', year: '2025',
      field: 'Hospitality Management', location: 'Angeles City', honors: '' }],
    experience: [{ position: 'F&B Intern', company: 'Clark hotel', months: 6, description: 'Front of house.',
      location: 'Clark Freeport Zone', startDate: 'Jan 2025', endDate: '', current: true,
      bullets: ['Served 60+ covers per shift', '', '   ', 'Handled POS billing'] }],  // blanks dropped
    skills: ['Customer Service', 'POS'],
    certifications: [{ name: 'Food Safety Training', year: '2025', issuer: 'TESDA', credentialId: '' }],
    projects: [
      { name: 'Banquet checklist app', role: 'Builder', startDate: 'Aug 2025', endDate: '', description: 'A checklist.', link: 'github.com/mg/banquet' },
      { name: '   ', role: 'dropped' },    // nameless entries are dropped by both
    ],
    languages: [{ name: 'Filipino', proficiency: 'Native' }, { name: 'English', proficiency: '' }],
    references: [],                        // empty section must vanish entirely
  });

  const d: any = await demo.resumes.save(payload(null) as any);
  const a: any = await api('resumes/save', { resume: payload(null) });
  assert.equal(d.ok, true, `demo save failed: ${d.error ?? ''}`);
  assert.equal(a.ok, true, `api save failed: ${a.error ?? ''}`);

  // Read back through the same path the builder and the print sheet use.
  const dGot: any = await demo.resumes.get(d.resume.id);
  const aGot: any = await api('resumes/get', { id: a.resume.id });
  assert.equal(dGot.ok, true);
  assert.equal(aGot.ok, true);
  const dr = dGot.resume;
  const ar = aGot.resume;

  assert.equal(dr.design, 'technical', 'demo mode rejected a design the picker offers');
  assert.equal(ar.design, 'technical', 'api mode rejected a design the picker offers');

  assert.equal(dr.personal.headline, ar.personal.headline);
  assert.equal(dr.personal.linkedin, ar.personal.linkedin);
  assert.equal('portfolio' in dr.personal, false, 'demo kept an empty portfolio');
  assert.equal('portfolio' in ar.personal, false, 'api kept an empty portfolio');

  assert.equal(dr.education[0].field, ar.education[0].field);
  assert.equal('honors' in dr.education[0], false, 'demo kept an empty honors field');
  assert.equal('honors' in ar.education[0], false, 'api kept an empty honors field');

  const de = dr.experience[0];
  const ae = ar.experience[0];
  assert.equal(de.months, ae.months);
  assert.equal(de.startDate, ae.startDate);
  assert.equal(de.current, true);
  assert.equal(ae.current, true);
  assert.equal('endDate' in de, false, 'demo kept an empty end date');
  assert.equal('endDate' in ae, false, 'api kept an empty end date');
  assert.deepEqual(de.bullets, ['Served 60+ covers per shift', 'Handled POS billing']);
  assert.deepEqual(ae.bullets, de.bullets, 'bullets differ between modes');

  assert.equal(dr.certifications[0].issuer, ar.certifications[0].issuer);
  assert.equal('credentialId' in dr.certifications[0], false);
  assert.equal('credentialId' in ar.certifications[0], false);

  assert.equal(dr.projects.length, 1, 'demo kept a nameless project');
  assert.equal(ar.projects.length, 1, 'api kept a nameless project');
  assert.equal(dr.projects[0].name, ar.projects[0].name);
  assert.equal(dr.projects[0].link, ar.projects[0].link);
  assert.equal('endDate' in dr.projects[0], false);
  assert.equal('endDate' in ar.projects[0], false);

  assert.deepEqual(dr.languages, ar.languages, 'languages differ between modes');
  assert.equal('proficiency' in dr.languages[1], false, 'demo kept an empty proficiency');

  assert.equal('references' in dr, false, 'demo returned an empty references section');
  assert.equal('references' in ar, false, 'api returned an empty references section');

  // And a saved resume still scores — the engine reads only skills, level and
  // months, so none of the above may change the number.
  const dP: any = await demo.postings.open();
  const aP: any = await api('postings/list');
  const dPost = dP.postings[0];
  const aPost = aP.postings.find((p: any) => p.title === dPost.title);
  const dS: any = await demo.match.score(dr.id, dPost.id);
  const aS: any = await api('match/score', { resumeId: ar.id, postingId: aPost.id });
  assert.equal(dS.score, aS.score, 'a resume with the new sections scores differently between modes');
});

/* The applicant's own file is read and scored in api mode. Demo mode has no
   server and no API key, so it CANNOT read a document — and must not pretend
   to. What has to agree between the modes is the contract, not the number:
   a score appears only where a document was actually read, and the reason is
   always stated. An invented demo score would be the worst outcome here,
   because demo mode is what gets demonstrated. */
test('neither mode ever invents a score for a file it could not read', async () => {
  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });

  const dR: any = await demo.resumes.mine();
  const aR: any = await api('resumes/list');
  const dPost: any = (await demo.postings.open()).postings[0];
  const aPost: any = (await api('postings/list')).postings.find((p: any) => p.title === dPost.title);

  for (const [label, resume, score] of [
    ['demo', dR.resumes.find((r: any) => r.ownFile), await demo.match.score(dR.resumes.find((r: any) => r.ownFile)?.id, dPost.id)],
    ['api', aR.resumes.find((r: any) => r.ownFile), await api('match/score', { resumeId: aR.resumes.find((r: any) => r.ownFile)?.id, postingId: aPost.id })],
  ] as [string, any, any][]) {
    if (!resume) continue;                     // that mode's seed has no attached file
    assert.ok(resume.ownFile, `${label}: expected an attached file`);

    const readable = resume.ownFile.extractStatus === 'ok';
    if (!readable) {
      assert.ok(!score.fileScore,
        `${label} mode produced a score for a file it never read (status=${resume.ownFile.extractStatus})`);
      assert.ok(resume.ownFile.extractStatus,
        `${label} mode gave no reason for the missing reading — "unread" must never look like "scored zero"`);
    } else {
      assert.equal(typeof score.fileScore?.score, 'number', `${label}: a read file must carry a score`);
    }

    // Whatever happened to the file, the RANKING score is unaffected: it is
    // computed from the structured resume alone, in both modes.
    assert.equal(typeof score.score, 'number', `${label}: the ranking score must always be present`);
  }
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

test('a recruiter setting per-opening weights gets the same answer in both modes', async () => {
  /* Demo mode is a separate hand-written implementation and it is the one
     that gets demonstrated. Weights scale every score an opening produces, so
     a validation rule the two modes disagree about would mean the walkthrough
     shows a posting being saved that the real system refuses — or, worse, an
     applicant scored on one split in the demo and another on the server. */
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const base = {
    title: 'Parity Weighted Role',
    department: 'Information Technology',
    description: 'Created by the parity suite to compare weight validation across the two modes.',
    skills: ['JavaScript', 'Git'],
    educationLevel: 'bachelor',
    minExperienceMonths: 0,
  };

  // Every rejection must be a rejection on both sides.
  for (const weights of [
    { skills: 50, education: 25, experience: 20 },   // 95
    { skills: 40, education: 40, experience: 40 },   // 120
    { skills: 90, education: 5, experience: 5 },     // below the floor
    { skills: 80, education: 20, experience: 0 },    // a criterion switched off
  ]) {
    await agree(
      `postings.save with weights ${JSON.stringify(weights)}`,
      demo.postings.save({ ...base, weights } as any),
      api('postings/save', { posting: { ...base, weights } }),
    );
  }

  // And an accepted set must be stored the same way — whole percentages,
  // never a fraction on one side and a percentage on the other.
  const good = { skills: 70, education: 15, experience: 15 };
  const d: any = await demo.postings.save({ ...base, weights: good } as any);
  const a: any = await api('postings/save', { posting: { ...base, weights: good } });
  assert.ok(d.ok && a.ok, `both modes must accept ${JSON.stringify(good)}`);
  assert.deepEqual(d.posting.weights, good, 'demo mode stores whole percentages');
  assert.deepEqual(a.posting.weights, good, 'api mode stores whole percentages');

  // An opening that sets none reports none in both, rather than a frozen copy
  // of whatever the defaults happened to be.
  const d2: any = await demo.postings.save({ ...base, title: 'Parity Inheriting Role' } as any);
  const a2: any = await api('postings/save', { posting: { ...base, title: 'Parity Inheriting Role' } });
  assert.ok(d2.ok && a2.ok);
  assert.equal(d2.posting.weights, null);
  assert.equal(a2.posting.weights, null);
});
