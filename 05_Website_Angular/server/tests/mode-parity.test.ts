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

test('no seeded application starts out flagged as drifted, in either mode', async () => {
  /* The seeded snapshots were once typed by hand, fell behind the engine,
     and put a "score drifted" warning on nearly every applicant in the demo
     — the recruiter's recorded number disagreeing with the live one on
     resumes nobody had touched. Run FIRST, before any test here edits a
     resume, so a drift can only come from the seed itself. */
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  for (const [label, list, ranked] of [
    ['demo', () => demo.postings.mine(), (id: string) => demo.applications.ranked(id)],
    ['api', () => api('postings/mine'), (id: string) => api('applications/ranked', { postingId: id })],
  ] as const) {
    const ps: any = await (list as any)();
    let seen = 0;
    for (const p of ps.postings) {
      const r: any = await (ranked as any)(p.id);
      for (const row of r.rows || []) {
        seen++;
        assert.equal(row.scoreDrifted, false,
          `${label}: ${row.resume?.title} @ ${p.title} is stored as ${row.score} but scores ${row.liveScore}`);
      }
    }
    assert.ok(seen >= 5, `${label}: expected the five seeded applications, saw ${seen}`);
  }
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

test('a resume title already taken is refused in both modes', async () => {
  /* The title is the ONLY thing that tells two of an applicant's resumes
     apart — on the dashboard, in the picker when they apply, and against the
     application a recruiter receives. Two called the same thing means the
     applicant chooses blind, and a wrong choice is invisible afterwards: the
     application simply carries the other document.

     Demo mode is what gets demonstrated, so a rule the server holds and the
     demo does not would make the demonstration a misrepresentation. */
  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });

  const dR: any = await demo.resumes.mine();
  const aR: any = await api('resumes/list');
  const taken = dR.resumes[0].title;
  assert.ok(taken, 'the seeded applicant must already own a titled resume');
  assert.ok(aR.resumes.some((r: any) => r.title === taken), 'both modes must seed the same title');

  const draft = (title: string) => ({
    title,
    template: 'chronological', design: 'classic',
    personal: { fullName: 'Marco Dizon', email: 'marco@demo.ph', phone: '0917 123 4567', address: '', summary: 'A summary of two plain sentences.' },
    education: [{ school: 'HAU', degree: 'BS Information Technology', level: 'bachelor', year: '2025' }],
    experience: [], skills: ['Customer Service'], certifications: [],
  });

  await agree('a NEW resume under a title this applicant already holds',
    demo.resumes.save(draft(taken) as any), api('resumes/save', { resume: draft(taken) }));

  // Case must not be an escape hatch: "My Resume" and "my resume" are the
  // same name to the person reading the list.
  await agree('the same title in a different case',
    demo.resumes.save(draft(taken.toUpperCase()) as any), api('resumes/save', { resume: draft(taken.toUpperCase()) }));

  // ...and a free title is still accepted, or the rule would read as a pass
  // simply by refusing everything.
  const free = 'Parity draft ' + Date.now();
  const [dFree, aFree]: any[] = await Promise.all([demo.resumes.save(draft(free) as any), api('resumes/save', { resume: draft(free) })]);
  // Asserted as a SUCCESS, not merely as agreement: two modes refusing a
  // valid draft for some other reason would "agree" and prove nothing.
  assert.equal(dFree.ok, true, `demo refused a free title: ${dFree.error}`);
  assert.equal(aFree.ok, true, `api refused a free title: ${aFree.error}`);
});

test('duplicating twice gives each copy a title of its own, in both modes', async () => {
  /* Without this the second copy would collide with the first and could not
     be saved at all — the rule above would have made "Duplicate" a button
     that produces an unsaveable resume. */
  await demo.auth.login('liza@demo.ph', 'demo123');
  await api('auth/login', { email: 'liza@demo.ph', password: 'demo123' });

  const dR: any = await demo.resumes.mine();
  const aR: any = await api('resumes/list');
  const dId = dR.resumes[0].id;
  const aId = aR.resumes.find((r: any) => r.title === dR.resumes[0].title)?.id ?? aR.resumes[0].id;

  const dTitles: string[] = [];
  const aTitles: string[] = [];
  for (let i = 0; i < 3; i++) {
    dTitles.push(((await demo.resumes.duplicate(dId)) as any).resume.title);
    aTitles.push(((await api('resumes/duplicate', { id: aId })) as any).resume.title);
  }
  assert.deepEqual(dTitles, aTitles, 'the two modes name the copies differently');
  assert.equal(new Set(dTitles).size, 3, `copies reused a title: ${dTitles.join(' | ')}`);
  assert.ok(dTitles[0].endsWith('(copy)'), `first copy should end "(copy)", got ${dTitles[0]}`);
  assert.ok(dTitles[1].endsWith('(copy 2)'), `second copy should end "(copy 2)", got ${dTitles[1]}`);
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
  // The four optional components come back as 0 rather than absent: the
  // breakdown shown to an applicant has to add up to the score printed beside
  // it, and a null term would not. Both modes have to agree on that, because
  // an opening saved in one and read in the other is the same opening.
  const stored = { ...good, certifications: 0, projects: 0, languages: 0, references: 0, relevance: 0, field: 0 };
  const d: any = await demo.postings.save({ ...base, weights: good } as any);
  const a: any = await api('postings/save', { posting: { ...base, weights: good } });
  assert.ok(d.ok && a.ok, `both modes must accept ${JSON.stringify(good)}`);
  assert.deepEqual(d.posting.weights, stored, 'demo mode stores whole percentages');
  assert.deepEqual(a.posting.weights, stored, 'api mode stores whole percentages');

  /* And an optional component itself agrees across the two. This is the pair
     that matters most for it: a recruiter sets a certifications share, and
     the live preview a seeker sees while editing has to equal the number the
     server stores when they apply. The three the recruiter did not touch
     still come back as 0 on both sides. */
  const withCerts = { skills: 40, education: 20, experience: 20, certifications: 20 };
  const certStored = { ...withCerts, projects: 0, languages: 0, references: 0, relevance: 0, field: 0 };
  const certBase = { ...base, certifications: ['CCNA'] };
  const dCert: any = await demo.postings.save({ ...certBase, weights: withCerts } as any);
  const aCert: any = await api('postings/save', { posting: { ...certBase, weights: withCerts } });
  assert.ok(dCert.ok && aCert.ok, 'both modes must accept a four-way split');
  assert.deepEqual(dCert.posting.weights, certStored, 'demo mode stores the certifications share');
  assert.deepEqual(aCert.posting.weights, certStored, 'api mode stores the certifications share');
  assert.deepEqual(dCert.posting.certifications, ['CCNA']);
  assert.deepEqual(aCert.posting.certifications, ['CCNA']);

  // An opening that sets none reports none in both, rather than a frozen copy
  // of whatever the defaults happened to be.
  const d2: any = await demo.postings.save({ ...base, title: 'Parity Inheriting Role' } as any);
  const a2: any = await api('postings/save', { posting: { ...base, title: 'Parity Inheriting Role' } });
  assert.ok(d2.ok && a2.ok);
  assert.equal(d2.posting.weights, null);
  assert.equal(a2.posting.weights, null);
});

test('screening questions behave identically in both modes', async () => {
  /* The questions are what an applicant must get past to apply at all. A
     demonstration in which they can be skipped, or in which editing the
     opening silently destroys the answers already collected, would show the
     panel a system that does not exist. */
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const base = {
    title: 'Parity — screening questions', department: 'Information Technology',
    employmentType: 'full-time' as const, description: 'An opening that asks its applicants two questions.',
    educationLevel: 'none' as const, minExperienceMonths: 0, skills: ['Communication'],
  };
  const asked = [{ prompt: 'Notice period?' }, { prompt: 'Expected salary?' },
                 { prompt: 'notice PERIOD?' }];   // the third is the first again

  const d: any = await demo.postings.save({ ...base, questions: asked } as any);
  const a: any = await api('postings/save', { posting: { ...base, questions: asked } });
  assert.equal(d.ok, true, `demo: ${d.error ?? ''}`);
  assert.equal(a.ok, true, `api: ${a.error ?? ''}`);
  assert.deepEqual(d.posting.questions.map((q: any) => q.prompt), ['Notice period?', 'Expected salary?'],
    'demo mode must fold the duplicate prompt');
  assert.deepEqual(a.posting.questions.map((q: any) => q.prompt), ['Notice period?', 'Expected salary?'],
    'api mode must fold the duplicate prompt');

  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  // demo mode calls it `mine`; the HTTP route is `resumes/list`. Same list.
  const dRid = (await demo.resumes.mine() as any).resumes[0].id;
  const aRid = (await api('resumes/list')).resumes[0].id;

  // Unanswered is refused in both, and both name the question rather than counting.
  const dNo: any = await demo.applications.apply(dRid, d.posting.id);
  const aNo: any = await api('applications/apply', { resumeId: aRid, postingId: a.posting.id });
  assert.equal(dNo.ok, false, 'demo mode accepted an application with no answers');
  assert.equal(aNo.ok, false, 'api mode accepted an application with no answers');
  assert.match(String(dNo.error), /Notice period/);
  assert.match(String(aNo.error), /Notice period/);

  // Blank-but-present is refused in both, so neither can be satisfied with spaces.
  const blanks = (qs: any[]) => qs.map((q) => ({ questionId: String(q.id), answer: '   ' }));
  const dBlank: any = await demo.applications.apply(dRid, d.posting.id, blanks(d.posting.questions));
  const aBlank: any = await api('applications/apply', { resumeId: aRid, postingId: a.posting.id, answers: blanks(a.posting.questions) });
  assert.equal(dBlank.ok, false, 'demo mode accepted whitespace as an answer');
  assert.equal(aBlank.ok, false, 'api mode accepted whitespace as an answer');

  // Answered is accepted in both.
  const real = (qs: any[]) => qs.map((q, i) => ({ questionId: String(q.id), answer: `answer ${i + 1}` }));
  const dYes: any = await demo.applications.apply(dRid, d.posting.id, real(d.posting.questions));
  const aYes: any = await api('applications/apply', { resumeId: aRid, postingId: a.posting.id, answers: real(a.posting.questions) });
  assert.equal(dYes.ok, true, `demo: ${dYes.error ?? ''}`);
  assert.equal(aYes.ok, true, `api: ${aYes.error ?? ''}`);

  /* AND AN UNRELATED EDIT DESTROYS NOTHING. This is the case that was wrong
     in api mode: every save deleted the question rows and reinserted them, so
     rewriting the description threw away every answer already collected.
     Demo mode kept them, which is precisely why the two had to be compared. */
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const keep = { ...base, description: 'A completely rewritten description of the role.',
                 questions: [{ prompt: 'Notice period?' }, { prompt: 'Expected salary?' }] };
  const dEd: any = await demo.postings.save({ ...keep, id: d.posting.id } as any);
  const aEd: any = await api('postings/save', { posting: { ...keep, id: a.posting.id } });
  assert.equal(dEd.ok, true, `demo: ${dEd.error ?? ''}`);
  assert.equal(aEd.ok, true, `api: ${aEd.error ?? ''}`);

  const dRank: any = await demo.applications.ranked(d.posting.id);
  const aRank: any = await api('applications/ranked', { postingId: a.posting.id });
  const dRow = dRank.rows.find((r: any) => r.resume?.id === dRid);
  const aRow = aRank.rows.find((r: any) => r.resume?.id === aRid);
  assert.equal(dRow?.answers?.length, 2, 'demo mode lost the answers when the description changed');
  assert.equal(aRow?.answers?.length, 2, 'api mode lost the answers when the description changed');
  assert.deepEqual(dRow.answers.map((x: any) => x.answer), ['answer 1', 'answer 2']);
  assert.deepEqual(aRow.answers.map((x: any) => x.answer), ['answer 1', 'answer 2']);
  /* And on the QUESTION, under the same field name. The two modes once
     disagreed here — demo emitted `prompt` and the server emitted `question` —
     so the recruiter's panel, which renders `prompt`, showed answers with no
     question above them in api mode and rendered correctly in demo mode. */
  assert.deepEqual(dRow.answers.map((x: any) => x.prompt), ['Notice period?', 'Expected salary?'],
    'demo mode must name the question under `prompt`');
  assert.deepEqual(aRow.answers.map((x: any) => x.prompt), ['Notice period?', 'Expected salary?'],
    'api mode must name the question under `prompt`');

  // Rewording ONE question drops that answer and only that one, in both.
  const rew = { ...base, questions: [{ prompt: 'Notice period?' }, { prompt: 'What salary are you expecting?' }] };
  await demo.postings.save({ ...rew, id: d.posting.id } as any);
  await api('postings/save', { posting: { ...rew, id: a.posting.id } });
  const dRank2: any = await demo.applications.ranked(d.posting.id);
  const aRank2: any = await api('applications/ranked', { postingId: a.posting.id });
  const dLeft = dRank2.rows.find((r: any) => r.resume?.id === dRid)?.answers ?? [];
  const aLeft = aRank2.rows.find((r: any) => r.resume?.id === aRid)?.answers ?? [];
  assert.equal(dLeft.length, 1, 'demo mode kept an answer to wording nobody was asked');
  assert.equal(aLeft.length, 1, 'api mode kept an answer to wording nobody was asked');
  assert.equal(dLeft[0].answer, 'answer 1');
  assert.equal(aLeft[0].answer, 'answer 1');
});

test('private links and hidden sections behave identically in both modes', async () => {
  /* Both features decide what a recruiter is shown. A mode that printed a
     link the other kept off the sheet, or scored a section the other hid,
     would make the demonstration a misrepresentation of the live system. */
  /* NOT liza — the password-policy test above changes her password in both
     modes, so signing in as her here fails identically on both sides and the
     comparison would pass while measuring nothing. */
  const dl: any = await demo.auth.login('ana@demo.ph', 'demo123');
  const al: any = await api('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  assert.equal(dl.ok, true, `demo login: ${dl.error ?? ''}`);
  assert.equal(al.ok, true, `api login: ${al.error ?? ''}`);

  const payload = (id: any) => ({
    id, title: 'Parity — links and hidden sections',
    template: 'chronological', design: 'classic',
    personal: { fullName: 'Ana Reyes', email: 'ana@demo.ph', phone: '0917 111 1111', address: 'Mabalacat', summary: 'Parity.' },
    education: [{ school: 'HAU', degree: 'BS IT', level: 'bachelor', year: '2025' }],
    experience: [{ position: 'Intern', company: 'Clark', months: 6, description: 'x' }],
    skills: ['Communication'],
    certifications: [{ name: 'CCNA', year: '2024' }],
    languages: [{ name: 'Filipino' }],
    links: [
      { label: 'Portfolio', url: 'https://example.ph/p' },
      { label: 'XSS', url: 'javascript:alert(1)' },
      { label: 'Relative', url: '/local' },
      { url: 'https://example.ph/bare' },
    ],
    hiddenSections: ['certifications', 'skills', 'nonsense'],  // two of these are not hideable
  });

  const d: any = await demo.resumes.save(payload(null) as any);
  const a: any = await api('resumes/save', { resume: payload(null) });
  assert.equal(d.ok, true, `demo: ${d.error ?? ''}`);
  assert.equal(a.ok, true, `api: ${a.error ?? ''}`);

  const norm = (ls: any[] = []) => ls.map((l) => `${l.label ?? ''}|${l.url}`).sort();
  assert.deepEqual(norm(d.resume.links), norm(a.resume.links), 'the two modes kept different links');
  assert.deepEqual(norm(a.resume.links), ['Portfolio|https://example.ph/p', '|https://example.ph/bare'].sort(),
    'only the http(s) addresses survive — a javascript: URL would run in the recruiter’s browser');

  assert.deepEqual(d.resume.hiddenSections, a.resume.hiddenSections, 'the two modes hid different sections');
  assert.deepEqual(a.resume.hiddenSections, ['certifications'],
    'skills cannot be hidden — it is one of the three every opening scores — and an invented name is dropped');
  assert.ok((a.resume.skills ?? []).length > 0 && (d.resume.skills ?? []).length > 0,
    'skills are still on the resume in both modes');
  assert.equal(a.resume.certifications.length, 1, 'api mode keeps the hidden contents for the owner');
  assert.equal(d.resume.certifications.length, 1, 'demo mode keeps the hidden contents for the owner');

  /* The hidden section leaves the score in both, by the same number of
     points: an opening that puts a fifth of the score on certificates. */
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const opening = {
    title: 'Parity — certificate weighted', department: 'Information Technology',
    employmentType: 'full-time' as const, description: 'Puts a fifth of the score on a certificate.',
    educationLevel: 'none' as const, minExperienceMonths: 0, skills: ['Communication'],
    certifications: ['CCNA'],
    weights: { skills: 40, education: 20, experience: 20, certifications: 20 },
  };
  const dp: any = await demo.postings.save(opening as any);
  const ap: any = await api('postings/save', { posting: opening });

  await demo.auth.login('ana@demo.ph', 'demo123');
  await api('auth/login', { email: 'ana@demo.ph', password: 'demo123' });

  const dHidden: any = await demo.match.score(d.resume.id, dp.posting.id);
  const aHidden: any = await api('match/score', { resumeId: a.resume.id, postingId: ap.posting.id });
  assert.equal(dHidden.score, aHidden.score, 'the two modes scored a hidden certificate differently');

  const shown = (r: any) => ({ ...payload(r.id), hiddenSections: [] });
  await demo.resumes.save(shown(d.resume) as any);
  await api('resumes/save', { resume: shown(a.resume) });
  const dShown: any = await demo.match.score(d.resume.id, dp.posting.id);
  const aShown: any = await api('match/score', { resumeId: a.resume.id, postingId: ap.posting.id });
  assert.equal(dShown.score, aShown.score, 'the two modes scored a shown certificate differently');
  assert.ok(dShown.score > dHidden.score,
    `hiding a scored section must cost points in demo mode, got ${dHidden.score} then ${dShown.score}`);
  assert.ok(aShown.score > aHidden.score,
    `hiding a scored section must cost points in api mode, got ${aHidden.score} then ${aShown.score}`);
});

test('the resume limit is enforced identically in both modes', async () => {
  await demo.auth.login('ana@demo.ph', 'demo123');
  await api('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const draft = (title: string) => ({
    title, template: 'chronological', design: 'classic',
    personal: { fullName: 'Ana Reyes', email: 'ana@demo.ph', phone: '0917 123 4567', address: '', summary: 'Two plain sentences.' },
    education: [{ school: 'HAU', degree: 'BS Computer Science', level: 'bachelor', year: '2025' }],
    experience: [], skills: ['Teamwork'], certifications: [],
  });
  const count = async () => [((await demo.resumes.mine()) as any).resumes.length, ((await api('resumes/list')) as any).resumes.length];
  let [d, a] = await count();
  for (let n = 1; d < 20; n++, d++) await demo.resumes.save(draft(`Parity limit ${n}`) as any);
  for (let n = 1; a < 20; n++, a++) await api('resumes/save', { resume: draft(`Parity limit ${n}`) });
  assert.deepEqual(await count(), [20, 20]);
  await agree('the twenty-first resume', demo.resumes.save(draft('One too many') as any), api('resumes/save', { resume: draft('One too many') }));
  assert.deepEqual(await count(), [20, 20], 'neither mode may accept it');
});

test('pay, shift, setup, location and openings follow the same rules in both modes', async () => {
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const base = {
    title: 'Parity Facts Role', department: 'Customer Support', employmentType: 'full-time',
    description: 'Checks the stated facts about a job in both modes.', skills: ['Customer Service'],
    educationLevel: 'highschool', minExperienceMonths: 0,
  };
  for (const [label, extra] of [
    ['a full, valid set', { salaryMin: '18,000', salaryMax: 22000, shift: 'night', workSetup: 'hybrid', workLocation: 'Clark', vacancies: 3 }],
    ['words for a salary', { salaryMin: 'about 20k' }],
    ['an upside-down range', { salaryMin: 25000, salaryMax: 18000 }],
    ['zero openings', { vacancies: 0 }],
    ['an unknown shift', { shift: 'graveyard' }],
  ] as const) {
    await agree(label, demo.postings.save({ ...base, ...extra } as any), api('postings/save', { posting: { ...base, ...extra } }));
  }
  // …and when both accept, they store the same facts.
  const d: any = await demo.postings.save({ ...base, salaryMin: '18,000', shift: 'night', vacancies: 3 } as any);
  const a: any = await api('postings/save', { posting: { ...base, salaryMin: '18,000', shift: 'night', vacancies: 3 } });
  for (const k of ['salaryMin', 'salaryMax', 'shift', 'workSetup', 'workLocation', 'vacancies', 'filled']) {
    assert.deepEqual(d.posting[k] ?? null, a.posting[k] ?? null, `${k} differs between the modes`);
  }
});

test('a filled opening closes itself in both modes', async () => {
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const base = {
    title: 'Parity One Seat', department: 'Customer Support', description: 'Hiring exactly one person here.',
    skills: ['Customer Service'], educationLevel: 'highschool', minExperienceMonths: 0, vacancies: 1,
  };
  const dp: any = (await demo.postings.save(base as any)).posting;
  const ap: any = (await api('postings/save', { posting: base })).posting;

  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const dr = ((await demo.resumes.mine()) as any).resumes[0].id;
  const ar = ((await api('resumes/list')) as any).resumes[0].id;
  const da: any = (await demo.applications.apply(dr, dp.id)).application;
  const aa: any = ((await api('applications/apply', { resumeId: ar, postingId: ap.id })) as any).application;

  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const dh: any = await demo.applications.setStatus(da.id, 'hired');
  const ah: any = await api('applications/set-status', { id: aa.id, status: 'hired' });
  assert.equal(dh.postingClosed, true, 'demo did not close the filled opening');
  assert.equal(ah.postingClosed, true, 'api did not close the filled opening');
  assert.equal(((await demo.postings.get(dp.id)) as any).posting.status, 'closed');
  assert.equal(((await api('postings/get', { id: ap.id })) as any).posting.status, 'closed');
});

test('bad contact details are refused, and good ones accepted, in both modes', async () => {
  // Juan: Liza's password is changed by the policy test above, and Ana is at
  // the resume limit by now. Sign-in is ASSERTED, so a failed login cannot
  // make every refusal below "agree" for the wrong reason.
  const dl: any = await demo.auth.login('seeker@demo.ph', 'demo123');
  const al: any = await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  assert.equal(dl.ok && al.ok, true, 'the harness must be signed in as the applicant in both modes');
  const draft = (personal: any, title: string) => ({
    title, template: 'chronological', design: 'classic',
    personal: { fullName: 'Juan Dela Cruz', email: 'seeker@demo.ph', phone: '0917 123 4567', address: '', summary: 'Two plain sentences.', ...personal },
    education: [{ school: 'HAU', degree: 'BS Information Technology', level: 'bachelor', year: '2025' }],
    experience: [], skills: ['Teamwork'], certifications: [],
  });
  for (const [label, personal] of [
    ['an email with no @', { email: 'wedawdawd' }],
    ['a 20-digit phone', { phone: '12312321312321321312' }],
    ['a LinkedIn field holding a GitHub link', { linkedin: 'github.com/juan' }],
  ] as const) {
    const [d, a]: any[] = await Promise.all([demo.resumes.save(draft(personal, 'Bad ' + label) as any), api('resumes/save', { resume: draft(personal, 'Bad ' + label) })]);
    assert.equal(d.ok, false, `demo accepted ${label}`);
    assert.equal(a.ok, false, `api accepted ${label}`);
    assert.equal(d.error, a.error, `${label}: the two modes say different things`);
  }
  const good = { email: 'juan.delacruz@gmail.com', phone: '+63 917 123 4567', linkedin: 'linkedin.com/in/juandelacruz' };
  const [d, a]: any[] = await Promise.all([demo.resumes.save(draft(good, 'Good contact') as any), api('resumes/save', { resume: draft(good, 'Good contact') })]);
  assert.equal(d.ok, true, `demo refused valid details: ${d.error}`);
  assert.equal(a.ok, true, `api refused valid details: ${a.error}`);
});

test('"hide below 50%" and the per-opening stage counts agree in both modes', async () => {
  await demo.auth.login('hr@demo.ph', 'demo123');
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const dPosts: any[] = ((await demo.postings.mine()) as any).postings;
  const aPosts: any[] = ((await api('postings/mine')) as any).postings;
  const key = (p: any) => p.title + ' | ' + p.department + ' | ' + p.createdAt;
  const aByKey = new Map(aPosts.map((p) => [p.title + ' | ' + p.department, p]));

  // The switch leaves the same people out, counts them the same, and is off
  // unless asked for: no minScore means nobody is left out.
  let sawLow = false;
  for (const dp of dPosts) {
    const ap = aByKey.get(dp.title + ' | ' + dp.department);
    if (!ap) continue;
    const dAll: any = await demo.applications.ranked(dp.id);
    const aAll: any = await api('applications/ranked', { postingId: ap.id });
    assert.equal(dAll.belowMin, 0, `demo hid applicants with the switch off @ ${key(dp)}`);
    assert.equal(aAll.belowMin, 0, `api hid applicants with the switch off @ ${key(dp)}`);
    const dHi: any = await demo.applications.ranked(dp.id, { minScore: 50 });
    const aHi: any = await api('applications/ranked', { postingId: ap.id, minScore: 50 });
    assert.deepEqual(dHi.rows.map((r: any) => r.score), aHi.rows.map((r: any) => r.score), dp.title);
    assert.equal(dHi.belowMin, aHi.belowMin, dp.title);
    assert.equal(dHi.matched + dHi.belowMin, dAll.matched, dp.title);
    assert.equal(aHi.matched + aHi.belowMin, aAll.matched, dp.title);
    assert.ok(aHi.rows.every((r: any) => r.score >= 50), dp.title);
    assert.equal(aHi.total, aAll.total, 'total must stay everyone who applied');
    if (aHi.belowMin > 0) sawLow = true;
  }
  assert.ok(sawLow, 'expected at least one seeded applicant below 50% to exercise the switch');

  // Each stage count splits by opening, and the split adds back up to it.
  const dS: any = (await demo.stats.hr()).stats;
  const aS: any = ((await api('stats/hr')) as any).stats;
  for (const [label, s, posts] of [['demo', dS, dPosts], ['api', aS, aPosts]] as const) {
    const sums: Record<string, number> = {};
    for (const [pid, cell] of Object.entries<any>(s.byPosting)) {
      assert.ok((posts as any[]).some((p) => p.id === pid), `${label}: byPosting names an unknown opening ${pid}`);
      for (const [st, n] of Object.entries<number>(cell)) {
        assert.ok(n > 0, `${label}: a zero cell was sent`);
        sums[st] = (sums[st] ?? 0) + n;
      }
    }
    for (const [st, n] of Object.entries<number>(s.byStatus)) assert.equal(sums[st] ?? 0, n, `${label}: ${st}`);
  }
  const named = (s: any, posts: any[]) => Object.fromEntries(Object.entries<any>(s.byPosting).map(([pid, cell]) => {
    const p = posts.find((x) => x.id === pid);
    return [p.title + ' | ' + p.department + ' | ' + p.status, cell];
  }));
  assert.deepEqual(named(dS, dPosts), named(aS, aPosts));
});

test('admin access is given, refused and taken away identically in both modes', async () => {
  await demo.auth.login('admin@demo.ph', 'demo123');
  await api('auth/login', { email: 'admin@demo.ph', password: 'demo123' });
  const shape = (r: any) => r.ok
    ? { ok: true, admins: r.admins.map((a: any) => [a.name, a.email, a.position, a.kind, a.isYou]) }
    : { ok: false, error: r.error };
  const dList: any = await demo.admin.admins();
  const aList: any = await api('admin/admins');
  assert.deepEqual(shape(dList), shape(aList));
  const byEmail = (list: any, e: string) => list.admins?.find((a: any) => a.email === e)?.id;
  const dRecs: any = (await demo.admin.recruiters()).recruiters;
  const aRecs: any = ((await api('admin/recruiters')) as any).recruiters;
  const dGrace = dRecs.find((r: any) => r.email === 'grace@demo.ph').id;
  const aGrace = aRecs.find((r: any) => r.email === 'grace@demo.ph').id;

  // the only admin
  assert.deepEqual(shape(await demo.admin.revokeAdmin(byEmail(dList, 'admin@demo.ph'))),
    shape(await api('admin/revoke-admin', { userId: byEmail(aList, 'admin@demo.ph') })));
  // grant, then grant again
  assert.deepEqual(shape(await demo.admin.grantAdmin(dGrace)), shape(await api('admin/grant-admin', { userId: aGrace })));
  assert.deepEqual(shape(await demo.admin.grantAdmin(dGrace)), shape(await api('admin/grant-admin', { userId: aGrace })));
  // add an IT manager: bad, then good
  for (const d of [
    { firstName: 'Jun', lastName: '', email: 'jun@clark.test', position: '' },
    { firstName: 'Jun', lastName: 'Reyes', email: 'nope', position: '' },
    { firstName: 'Jun', lastName: 'Reyes', email: 'grace@demo.ph', position: '' },
    { firstName: '  Jun ', lastName: 'Reyes', email: 'Jun.Parity@Clark.test', position: '  IT   Manager ' },
  ]) assert.deepEqual(shape(await demo.admin.addAdmin(d)), shape(await api('admin/add-admin', d)), JSON.stringify(d));

  // grace sees herself as an admin who still recruits, in both
  await demo.auth.login('grace@demo.ph', 'demo123');
  await api('auth/login', { email: 'grace@demo.ph', password: 'demo123' });
  const dMe: any = (await demo.auth.me()).user; const aMe: any = ((await api('auth/me')) as any).user;
  assert.equal(dMe.isAdmin, true); assert.equal(aMe.isAdmin, true);
  assert.equal(dMe.role, aMe.role);
  assert.equal((await demo.admin.requests()).ok, true);
  assert.equal(((await api('admin/requests')) as any).ok, true);
  // and takes it away again
  const dNow: any = await demo.admin.admins(); const aNow: any = await api('admin/admins');
  const dr: any = await demo.admin.revokeAdmin(byEmail(dNow, 'grace@demo.ph'));
  const ar: any = await api('admin/revoke-admin', { userId: byEmail(aNow, 'grace@demo.ph') });
  assert.deepEqual(shape(dr), shape(ar));
  assert.equal(dr.removedSelf, true); assert.equal(ar.removedSelf, true);
  assert.equal((await demo.admin.requests()).ok, false);
  assert.equal(((await api('admin/requests')) as any).ok, false);
});

test('the skill dictionary: same catalogue, same rules, same scores after a link, in both modes', async () => {
  const cat = (r: any) => r.catalogue.map((c: any) => `${c.name}|${c.category}|${c.industry}`).sort();
  const dD: any = await demo.skills.dictionary(); const aD: any = await api('skills/dictionary');
  assert.deepEqual(cat(dD), cat(aD), 'the same catalogue in both');
  assert.equal(dD.catalogue.length, 226);

  await demo.auth.login('admin@demo.ph', 'demo123');
  await api('auth/login', { email: 'admin@demo.ph', password: 'demo123' });
  const dV: any = await demo.skills.admin(); const aV: any = await api('skills/admin');
  const idOf = (v: any, name: string) => v.catalogue.find((c: any) => c.name === name)?.id ?? 'none';
  const outcome = (r: any) => (r.ok ? { ok: true } : { ok: false, error: r.error });

  // Every refusal, and the good cases, answered alike.
  const cases: [string, (v: any) => any, (v: any) => any][] = [
    ['link a built-in', (v) => demo.skills.link('Bookkeeper', idOf(v, 'Git')), (v) => api('skills/link', { alias: 'Bookkeeper', targetId: idOf(v, 'Git') })],
    ['link to itself', (v) => demo.skills.link('GIT', idOf(v, 'Git')), (v) => api('skills/link', { alias: 'GIT', targetId: idOf(v, 'Git') })],
    ['link blank', (v) => demo.skills.link(' ', idOf(v, 'Git')), (v) => api('skills/link', { alias: ' ', targetId: idOf(v, 'Git') })],
    ['link GitHub', (v) => demo.skills.link('GitHub', idOf(v, 'Git')), (v) => api('skills/link', { alias: 'GitHub', targetId: idOf(v, 'Git') })],
    ['link GitHub again', (v) => demo.skills.link('Github', idOf(v, 'Git')), (v) => api('skills/link', { alias: 'Github', targetId: idOf(v, 'Git') })],
    ['chain onto a target', (v) => demo.skills.link('Git', idOf(v, 'Bookkeeping')), (v) => api('skills/link', { alias: 'Git', targetId: idOf(v, 'Bookkeeping') })],
    ['add a built-in', () => demo.skills.add({ name: 'Bookkeeper', category: 'technical', industry: 'Finance' }), () => api('skills/add', { name: 'Bookkeeper', category: 'technical', industry: 'Finance' })],
    ['add an existing', () => demo.skills.add({ name: 'git', category: 'technical', industry: 'X' }), () => api('skills/add', { name: 'git', category: 'technical', industry: 'X' })],
    ['add bad kind', () => demo.skills.add({ name: 'Zapier', category: 'x', industry: '' }), () => api('skills/add', { name: 'Zapier', category: 'x', industry: '' })],
    ['add Zapier', () => demo.skills.add({ name: 'Zapier', category: 'technical', industry: '' }), () => api('skills/add', { name: 'Zapier', category: 'technical', industry: '' })],
    ['rename to another word', (v) => demo.skills.update({ id: idOf(v, 'Zapier'), name: 'Make.com', category: 'technical', industry: '' }), (v) => api('skills/update', { id: idOf(v, 'Zapier'), name: 'Make.com', category: 'technical', industry: '' })],
    ['recase and refile', (v) => demo.skills.update({ id: idOf(v, 'Zapier'), name: 'ZAPIER', category: 'soft', industry: 'Office Management' }), (v) => api('skills/update', { id: idOf(v, 'Zapier'), name: 'ZAPIER', category: 'soft', industry: 'Office Management' })],
    ['remove', (v) => demo.skills.remove(idOf(v, 'ZAPIER')), (v) => api('skills/remove', { id: idOf(v, 'ZAPIER') })],
    ['remove again', () => demo.skills.remove('nope'), () => api('skills/remove', { id: 0 })],
    ['unlink a missing link', () => demo.skills.unlink('nothere'), () => api('skills/unlink', { aliasNorm: 'nothere' })],
  ];
  let dv = dV, av = aV;
  for (const [label, d, a] of cases) {
    const dr: any = await d(dv); const ar: any = await a(av);
    assert.deepEqual(outcome(dr), outcome(ar), label);
    if (dr.ok) { dv = dr; av = ar; }
  }
  assert.deepEqual(cat(await demo.skills.dictionary()), cat(await api('skills/dictionary')), 'catalogues after the edits');
  assert.deepEqual((await demo.skills.dictionary() as any).links.map((l: any) => [l.aliasNorm, l.targetNorm]),
    ((await api('skills/dictionary')) as any).links.map((l: any) => [l.aliasNorm, l.targetNorm]));

  // And the point of it all: a resume saying GitHub now scores the same,
  // matched as Git, in both modes.
  await demo.auth.login('marco@demo.ph', 'demo123');
  await api('auth/login', { email: 'marco@demo.ph', password: 'demo123' });
  const draft = {
    title: 'GitHub parity', template: 'chronological', design: 'classic',
    personal: { fullName: 'Marco Garcia', email: 'marco@demo.ph', phone: '0917 123 4567', address: '', summary: 'Two plain sentences about me. Nothing more.' },
    education: [{ school: 'HAU', degree: 'BS Information Technology', level: 'bachelor', year: '2025' }],
    experience: [], skills: ['GitHub', 'HTML/CSS'], certifications: [],
  };
  const dRes: any = (await demo.resumes.save(draft as any)).resume;
  const aRes: any = ((await api('resumes/save', { resume: draft })) as any).resume;
  const dPosts: any = (await demo.postings.open()).postings; const aPosts: any = ((await api('postings/list')) as any).postings;
  const dP = dPosts.find((p: any) => p.skills.includes('Git'));
  assert.ok(dP, 'a seeded opening asks for Git');
  const aP = aPosts.find((p: any) => p.title === dP.title);
  const d: any = await demo.match.score(dRes.id, dP.id);
  const a: any = await api('match/score', { resumeId: aRes.id, postingId: aP.id });
  assert.ok(d.matchedSkills.includes('Git'), 'demo counts GitHub as Git');
  assert.equal(d.score, a.score);
  assert.deepEqual([...d.matchedSkills].sort(), [...a.matchedSkills].sort());

  // Leave both as found for any test after this one.
  await demo.auth.login('admin@demo.ph', 'demo123');
  await api('auth/login', { email: 'admin@demo.ph', password: 'demo123' });
  assert.deepEqual(outcome(await demo.skills.unlink('github')), outcome(await api('skills/unlink', { aliasNorm: 'github' })));
});
