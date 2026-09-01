/* ============================================================
   BOTH-SIDES INTEGRATION TESTS
   ------------------------------------------------------------
   The engine suite proves the arithmetic and the API suite proves
   the rules around it. This one proves the thing the study actually
   promises: that the applicant and the recruiter are looking at the
   SAME numbers and the SAME state for the same record.

   It exists because that promise broke in a way no other suite
   could see. Each side was internally consistent; they simply
   disagreed with each other, and every suite passed.

   Boots the real server against a throwaway PostgreSQL and drives
   both roles over HTTP, scoring the seeker's side with the CLIENT
   engine — the one their browser actually runs — and comparing it
   with what the server hands the recruiter.

     cd server && npm run test:both
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { scoreLocal, STATUS_LABELS, ALL_STATUSES } from '../../client/src/app/core/engine';

const DB = process.env.TEST_DB_NAME || 'linaw_bothsides';
const PORT = Number(process.env.TEST_PORT || 4403);
const BASE = `http://127.0.0.1:${PORT}/api`;
const SCHEMA = path.join(__dirname, '..', '..', 'db', 'linaw_ph.sql');
const PG = { host: '127.0.0.1', port: '5432', user: 'postgres', pass: 'postgres' };

const psql = (args: string[], db?: string) =>
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-h', PG.host, '-p', PG.port, '-U', PG.user,
    '-d', db ?? 'postgres', ...args], { env: { ...process.env, PGPASSWORD: PG.pass }, encoding: 'utf8' });

function client() {
  let cookie = '';
  return async function call(route: string, body: any = {}): Promise<any> {
    const res = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

let server: ChildProcess | null = null;
let seeker: any, hr: any, resume: any, postings: any[];

before(async () => {
  psql(['-c', `DROP DATABASE IF EXISTS ${DB}`]);
  psql(['-c', `CREATE DATABASE ${DB}`]);
  psql(['-f', SCHEMA], DB);
  server = spawn('node', ['-r', 'ts-node/register/transpile-only', 'src/server.ts'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DEBUG: 'false',
      DATABASE_URL: `postgresql://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${DB}`,
      SESSION_SECRET: 'x'.repeat(40) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/postings/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  seeker = client(); hr = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const listed = (await seeker('resumes/list')).body.resumes[0];
  resume = (await seeker('resumes/get', { id: listed.id })).body.resume;
  postings = (await seeker('postings/list')).body.postings;
});

after(() => { server?.kill(); try { psql(['-c', `DROP DATABASE IF EXISTS ${DB}`]); } catch {} });

test('a typed resume scores the same for the applicant and the recruiter, on every open posting', async () => {
  /* The applicant's number is computed HERE with the client engine, which is
     the code their browser runs, and compared with what the server hands the
     recruiter. A resume nobody has edited since applying must also match its
     own snapshot, and must not be flagged as drifted. */
  for (const p of postings) {
    const mine = scoreLocal(resume as any, p as any).score;
    await seeker('applications/apply', { resumeId: resume.id, postingId: p.id });
    const rows = (await hr('applications/ranked', { postingId: p.id })).body.rows || [];
    const row = rows.find((x: any) => x.resume.id === resume.id);
    assert.ok(row, `${p.title}: the recruiter cannot see the application`);
    assert.equal(row.liveScore, mine, `${p.title}: live scores differ`);
    assert.equal(row.score, mine, `${p.title}: the snapshot differs on an unedited resume`);
    assert.equal(row.scoreDrifted, false, `${p.title}: flagged as drifted without an edit`);
  }
});

/* Pick by what the case needs, never by position. These tests indexed
   postings[0] and broke the moment the seed's dates were staggered — and
   worse, postings[0] became an opening this resume matches nothing on, where
   removing skills cannot move the score at all and the test was asserting
   something that could not happen. */
const bestMatch = () => postings
  .map((p) => ({ p, s: scoreLocal(resume as any, p as any).score }))
  .sort((a, b) => b.s - a.s)[0].p;
const byTitle = (t: string) => {
  const p = postings.find((x) => x.title === t);
  assert.ok(p, `the seed no longer contains an opening called ${t}`);
  return p!;
};

test('an edit after applying moves the live score, never the one already sent', async () => {
  const p = bestMatch();
  const edited = JSON.parse(JSON.stringify(resume));
  edited.skills = edited.skills.slice(0, Math.max(1, edited.skills.length - 2));
  edited.skillEvidence = {};
  const after = (await seeker('resumes/save', { resume: edited })).body.resume;

  const now = scoreLocal(after as any, p as any).score;
  const row = (await hr('applications/ranked', { postingId: p.id })).body.rows
    .find((x: any) => x.resume.id === resume.id);

  assert.notEqual(now, row.score,
    'the edit did not change this resume\'s score against this opening, so the test proves nothing');
  assert.equal(row.liveScore, now, 'the two sides must still agree on what it scores NOW');
  assert.notEqual(row.score, now, 'the sent score must not follow the edit');
  assert.equal(row.scoreDrifted, true, 'and the recruiter must be told it moved');

  // put it back so the rest of the suite runs against the resume it expects
  await seeker('resumes/save', { resume });
});

test('the same record reads identically from both sides', async () => {
  const p = bestMatch();
  const row = (await hr('applications/ranked', { postingId: p.id })).body.rows
    .find((x: any) => x.resume.id === resume.id);
  const mine = (await seeker('resumes/get', { id: resume.id })).body.resume;

  assert.deepEqual(row.resume.skills, mine.skills, 'skills differ between the two views');
  assert.deepEqual(row.resume.skillEvidence ?? null, mine.skillEvidence ?? null, 'the evidence map differs');
  assert.equal(row.resume.education.length, mine.education.length);
  assert.equal(row.resume.experience.length, mine.experience.length);

  const local = scoreLocal(mine as any, p as any);
  assert.equal(row.liveScore, local.score, 'live score');
  assert.deepEqual([...row.matchedSkills].sort(), [...local.matchedSkills].sort(), 'matched skills');
  assert.deepEqual(row.weights, local.weights, 'the weights each side is shown');
});

test('a status set by the recruiter is the status the applicant sees', async () => {
  const p = bestMatch();
  const appId = (await hr('applications/ranked', { postingId: p.id })).body.rows[0].application.id;
  for (const st of ['review', 'shortlisted', 'hired'] as const) {
    const set = await hr('applications/set-status', { id: appId, status: st, reason: null });
    assert.equal(set.body.ok, true, `recruiter could not set ${st}: ${set.body.error}`);
    const mine = (await seeker('applications/mine')).body.applications.find((x: any) => x.id === appId);
    assert.equal(mine.status, st, `the applicant sees '${mine.status}' where the recruiter set '${st}'`);
    assert.ok(STATUS_LABELS[st], `'${st}' has no label on the client`);
  }
  const bad = await hr('applications/set-status', { id: appId, status: 'not_a_status', reason: null });
  assert.notEqual(bad.body.ok, true, 'an unknown status was accepted');
  const bySeeker = await seeker('applications/set-status', { id: appId, status: 'hired', reason: null });
  assert.notEqual(bySeeker.body.ok, true, 'an applicant set their own status');
});

test('withdrawing is the applicant’s decision, and a decided application is final', async () => {
  const decided = (await hr('applications/ranked', { postingId: bestMatch().id })).body.rows[0].application.id;
  const late = await seeker('applications/withdraw', { id: decided });
  assert.notEqual(late.body.ok, true, 'a hired application could still be withdrawn');

  const p = byTitle('Customer Support Agent');
  const row = (await hr('applications/ranked', { postingId: p.id })).body.rows
    .find((x: any) => x.resume.id === resume.id);
  assert.ok(row, 'the seeker has no application on this opening to withdraw');
  const wd = await seeker('applications/withdraw', { id: row.application.id });
  assert.equal(wd.body.ok, true, `withdraw failed: ${wd.body.error}`);

  const after = (await hr('applications/ranked', { postingId: p.id })).body.rows
    .find((x: any) => x.application.id === row.application.id);
  assert.ok(after, 'a withdrawn application vanished from the recruiter’s list');
  assert.equal(after.application.status, 'withdrawn');

  const byHr = await hr('applications/set-status', { id: row.application.id, status: 'withdrawn', reason: null });
  assert.notEqual(byHr.body.ok, true, 'a recruiter withdrew on the applicant’s behalf');
});

test('paging narrows what is drawn, never what is counted', async () => {
  /* The page promises that everyone who applied is on this list. A pager can
     keep that promise or break it, and the difference is whether `total`
     follows the filters. It must not: the tally is the pool, the page is the
     slice. Filters run on the SERVER for the same reason — narrowing one page
     would hide matching applicants sitting on another. */
  const p = bestMatch();
  const all = await hr('applications/ranked', { postingId: p.id });
  const everyone = all.body.rows.length;
  assert.ok(everyone >= 2, 'this test needs at least two applicants to page');

  const first = await hr('applications/ranked', { postingId: p.id, page: 1, pageSize: 1 });
  assert.equal(first.body.rows.length, 1, 'a page of one returns one row');
  assert.equal(first.body.total, everyone, 'total must report the whole pool, not the page');
  assert.equal(first.body.matched, everyone, 'with no filters, matched is the pool');
  assert.equal(first.body.pages, everyone, 'one row a page means one page per applicant');

  const second = await hr('applications/ranked', { postingId: p.id, page: 2, pageSize: 1 });
  assert.notEqual(second.body.rows[0].application.id, first.body.rows[0].application.id,
    'page two must be a different applicant');

  // the pages together are exactly the unpaged list, in the same order
  const walked: string[] = [];
  for (let i = 1; i <= everyone; i++) {
    const pg = await hr('applications/ranked', { postingId: p.id, page: i, pageSize: 1 });
    walked.push(pg.body.rows[0].application.id);
  }
  assert.deepEqual(walked, all.body.rows.map((r: any) => r.application.id),
    'walking the pages must reproduce the full ranking exactly');

  // an absent pageSize still means everything, so no existing caller is truncated
  assert.equal((await hr('applications/ranked', { postingId: p.id })).body.rows.length, everyone);

  // a filter narrows `matched` but never `total`
  const filtered = await hr('applications/ranked', { postingId: p.id, status: 'withdrawn' });
  assert.equal(filtered.body.total, everyone, 'a filter must not change the pool count');
  assert.ok(filtered.body.matched <= everyone);
  assert.equal(filtered.body.rows.length, filtered.body.matched);
});

test('every status the client names is one the server can hold', () => {
  for (const st of ALL_STATUSES) assert.ok(STATUS_LABELS[st], `'${st}' has no label`);
  assert.ok(ALL_STATUSES.includes('withdrawn'), 'withdrawn must be counted, not hidden');
});

test('a closed opening leaves the public list and refuses new applications', async () => {
  const p = byTitle('Patient Coordinator');
  assert.equal((await hr('postings/toggle', { id: p.id })).body.ok, true);

  const other = client();
  await other('auth/login', { email: 'ana@demo.ph', password: 'demo123' });
  const theirs = (await other('resumes/list')).body.resumes[0];
  const tried = await other('applications/apply', { resumeId: theirs.id, postingId: p.id });
  assert.notEqual(tried.body.ok, true, 'a closed opening accepted an application');
  assert.ok(!(await other('postings/list')).body.postings.some((x: any) => x.id === p.id),
    'a closed opening is still on the public list');

  await hr('postings/toggle', { id: p.id });
});
