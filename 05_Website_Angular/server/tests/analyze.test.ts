/* ============================================================
   AI EXTRACTION TESTS
   ------------------------------------------------------------
   The "upload & analyze" route, end to end, against a local
   stand-in for the Gemini API.

   The part worth testing is OURS, not Google's: the multipart
   handling, the role guard, the MIME whitelist, the size limit,
   and — most importantly — the coercion of whatever the model
   returns. The route treats that output as untrusted, and these
   prove it: a hostile or malformed response must not be able to
   put unbounded strings, wrong types, or thousands of rows into
   an applicant's resume.

   Also proves the paper's claim that extraction is data entry
   only: the response is a resume for the applicant to review,
   never a score.

     cd server && npm run test:analyze
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const DB = process.env.TEST_DB_NAME || 'resumematch_analyzetest';
const PORT = Number(process.env.TEST_PORT || 4396);
const BASE = `http://127.0.0.1:${PORT}/api`;
const SCHEMA = path.join(__dirname, '..', '..', 'db', 'resumematch_ph.sql');

const PG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || '5432',
  user: process.env.DB_USER || 'postgres',
  pass: process.env.DB_PASS || 'postgres',
};

let server: ChildProcess | null = null;
let fakeGemini: http.Server | null = null;

/** What the stand-in should answer with next. Tests set this. */
let nextReply: { status: number; body: any } = { status: 200, body: null };
let lastRequest: any = null;

function geminiEnvelope(payload: unknown) {
  // The real API wraps the model's JSON in candidates[].content.parts[].text
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] };
}

function psql(args: string[], db?: string) {
  return execFileSync('psql', [
    '-v', 'ON_ERROR_STOP=1', '-q',
    '-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', db ?? 'postgres', ...args,
  ], { env: { ...process.env, PGPASSWORD: PG.pass }, encoding: 'utf8' });
}

function client() {
  let cookie = '';
  const call = async (route: string, body: any = {}): Promise<any> => {
    const res = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  /** Upload a file to the analyze route with this client's session. */
  const upload = async (bytes: Buffer, filename: string, type: string) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), filename);
    const res = await fetch(`${BASE}/analyze/resume`, {
      method: 'POST', body: form, headers: cookie ? { Cookie: cookie } : {},
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return Object.assign(call, { upload });
}

/** A byte-valid minimal PDF, so the MIME check and any sniffing pass. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

before(async () => {
  fakeGemini = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { lastRequest = JSON.parse(raw); } catch { lastRequest = raw; }
      res.writeHead(nextReply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextReply.body ?? {}));
    });
  });
  await new Promise<void>((r) => fakeGemini!.listen(0, '127.0.0.1', () => r()));
  const geminiPort = (fakeGemini!.address() as any).port;

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
        PORT: String(PORT), SESSION_SECRET: 'analyze-test-secret', DEBUG: 'true',
        SMTP_HOST: '',
        /* PIN THE READER. This suite exists to test the GEMINI path — the
           multipart handling, the MIME check, and the coercion of whatever the
           model returns. It inherits process.env, so before this line it also
           inherited RESUME_EXTRACTOR from the developer's .env, and the moment
           that was pinned to 'rules' for the study these tests silently started
           exercising the rule-based reader instead and failed. A test that
           depends on ambient configuration is not testing what it claims to. */
        RESUME_EXTRACTOR: 'gemini',
        GEMINI_API_KEY: 'test-key-not-a-real-one',
        GEMINI_BASE_URL: `http://127.0.0.1:${geminiPort}`,
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
});

after(async () => {
  server?.kill('SIGKILL');
  if (fakeGemini) await new Promise<void>((r) => fakeGemini!.close(() => r()));
  try { psql(['-c', `DROP DATABASE IF EXISTS ${DB}`]); } catch { /* best effort */ }
});

// ---------- the happy path ----------

test('a resume file is extracted into structured fields', async () => {
  nextReply = { status: 200, body: geminiEnvelope({
    personal: { fullName: 'Juan Dela Cruz', email: 'juan@example.ph', phone: '0917 000 0000',
      address: 'San Fernando, Pampanga', summary: 'Front office associate.' },
    education: [{ school: 'Holy Angel University', degree: 'BS IT', level: 'bachelor', year: '2025' }],
    experience: [{ position: 'Receptionist', company: 'Hotel X', months: 8, description: 'Front desk.' }],
    skills: ['Customer Service', 'Front Office', 'MS Office'],
    certifications: [{ name: 'TESDA NC II Housekeeping', year: '2024' }],
  }) };

  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { body } = await api.upload(PDF, 'my-resume.pdf', 'application/pdf');

  assert.equal(body.ok, true, 'extraction should succeed: ' + JSON.stringify(body).slice(0, 200));
  assert.equal(body.resume.personal.fullName, 'Juan Dela Cruz');
  assert.equal(body.resume.education[0].level, 'bachelor');
  assert.equal(body.resume.experience[0].months, 8);
  assert.ok(body.resume.skills.includes('Customer Service'));

  // data entry only — the paper's claim. No score may come back from here.
  assert.equal(body.score, undefined, 'extraction must never return a score');
  assert.equal(body.tier, undefined, 'extraction must never return a tier');
});

test('the file actually reaches the model', async () => {
  nextReply = { status: 200, body: geminiEnvelope({ personal: {}, education: [], experience: [], skills: [], certifications: [] }) };
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  await api.upload(PDF, 'x.pdf', 'application/pdf');
  const parts = lastRequest?.contents?.[0]?.parts ?? [];
  assert.ok(parts.length > 0, 'the request must carry parts');
  const hasFile = JSON.stringify(parts).includes('inline_data') || JSON.stringify(parts).includes('inlineData');
  assert.ok(hasFile, 'the uploaded file must be sent to the model');
});

// ---------- the model's output is untrusted ----------

test('a hostile model response cannot inject unbounded data into a resume', async () => {
  nextReply = { status: 200, body: geminiEnvelope({
    personal: {
      fullName: 'A'.repeat(5000),
      email: 'B'.repeat(5000),
      summary: 'C'.repeat(50000),
    },
    education: Array.from({ length: 500 }, () => ({ school: 'S'.repeat(1000), level: 'wizard' })),
    experience: Array.from({ length: 500 }, () => ({ position: 'P', months: 999999 })),
    skills: Array.from({ length: 5000 }, (_, i) => 'skill' + i),
    certifications: Array.from({ length: 500 }, () => ({ name: 'N'.repeat(1000) })),
  }) };

  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { body } = await api.upload(PDF, 'evil.pdf', 'application/pdf');
  assert.equal(body.ok, true);
  const r = body.resume;

  assert.ok(r.personal.fullName.length <= 200, `fullName not clamped (${r.personal.fullName.length})`);
  assert.ok(r.personal.summary.length <= 2000, `summary not clamped (${r.personal.summary.length})`);
  // These are the limits sanitize() actually enforces, not looser ones —
  // a looser assertion would pass even if a clamp were weakened.
  assert.ok(r.education.length <= 10, `education not clamped (${r.education.length})`);
  assert.ok(r.experience.length <= 15, `experience not clamped (${r.experience.length})`);
  assert.ok(r.skills.length <= 30, `skills not clamped (${r.skills.length})`);
  assert.ok(r.certifications.length <= 10, `certifications not clamped (${r.certifications.length})`);

  // an invented education level must not survive into the scoring inputs
  for (const e of r.education)
    assert.ok(['none', 'highschool', 'vocational', 'associate', 'bachelor', 'master'].includes(e.level),
      `invalid education level survived: ${e.level}`);
  // months must stay a sane number
  for (const e of r.experience)
    assert.ok(typeof e.months === 'number' && e.months >= 0 && e.months <= 600,
      `implausible months survived: ${e.months}`);
});

test('wrong types from the model do not crash the route', async () => {
  nextReply = { status: 200, body: geminiEnvelope({
    personal: 'not an object',
    education: 'not an array',
    experience: [{ position: { nested: true }, months: 'eight' }],
    skills: [1, 2, { a: 1 }, null],
    certifications: null,
  }) };
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { status, body } = await api.upload(PDF, 'weird.pdf', 'application/pdf');
  assert.notEqual(status, 500, 'malformed model output must not be a server fault');
  if (body.ok) {
    assert.equal(typeof body.resume.personal, 'object');
    assert.ok(Array.isArray(body.resume.education));
    assert.ok(Array.isArray(body.resume.skills));
  }
});

test('non-JSON from the model is reported, not thrown', async () => {
  nextReply = { status: 200, body: { candidates: [{ content: { parts: [{ text: 'I am not JSON at all.' }] } }] } };
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { status, body } = await api.upload(PDF, 'prose.pdf', 'application/pdf');
  assert.notEqual(status, 500, 'a non-JSON reply must not be a server fault');
  assert.equal(body.ok, false, 'and it must not pretend to have extracted anything');
  assert.ok(typeof body.error === 'string' && body.error.length > 0, 'the user needs an explanation');
});

test('an upstream failure is explained, not leaked', async () => {
  nextReply = { status: 429, body: { error: { message: 'Quota exceeded for project 12345' } } };
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { status, body } = await api.upload(PDF, 'quota.pdf', 'application/pdf');
  assert.notEqual(status, 500);
  assert.equal(body.ok, false);
  assert.ok(!/project 12345/.test(body.error || ''), 'upstream internals must not reach the user');
});

// ---------- guards ----------

test('extraction refuses an anonymous caller', async () => {
  nextReply = { status: 200, body: geminiEnvelope({ personal: {}, education: [], experience: [], skills: [], certifications: [] }) };
  const api = client(); // never logs in
  const { body } = await api.upload(PDF, 'x.pdf', 'application/pdf');
  assert.equal(body.ok, false, 'an anonymous caller must not reach the model');
});

test('extraction refuses a recruiter', async () => {
  const api = client();
  await api('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const { body } = await api.upload(PDF, 'x.pdf', 'application/pdf');
  assert.equal(body.ok, false, 'this is a job seeker feature');
});

test('a file type outside the whitelist is refused', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const { body } = await api.upload(Buffer.from('#!/bin/sh\necho hi\n'), 'script.sh', 'application/x-sh');
  assert.equal(body.ok, false, 'a shell script is not a resume');
});

test('an oversized file is refused with a size message', async () => {
  const api = client();
  await api('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const big = Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024, 0x20)]); // > 2 MB
  const { status, body } = await api.upload(big, 'huge.pdf', 'application/pdf');
  assert.equal(body.ok, false);
  assert.match(String(body.error), /2\s*MB|too large/i,
    'the message must say the file is too big, not "service unavailable"');
  assert.notEqual(status, 500);
});
