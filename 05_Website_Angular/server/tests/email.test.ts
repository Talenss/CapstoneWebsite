/* ============================================================
   EMAIL DELIVERY TESTS
   ------------------------------------------------------------
   Everything the system sends, proven to actually leave the
   process: registration codes, password reset, the recruiter's
   new-application notice, status changes, job alerts and the
   interview invitation.

   Until now the only path exercised was the DEBUG branch that
   prints codes to the console — which is precisely the branch
   that never runs in production. These boot the real server
   against a real (local) SMTP server and read the messages off
   the wire.

     cd server && npm run test:email
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { SmtpSink } from './helpers/smtp-sink';

const DB = process.env.TEST_DB_NAME || 'resumematch_emailtest';
const PORT = Number(process.env.TEST_PORT || 4397);
const BASE = `http://127.0.0.1:${PORT}/api`;
const SCHEMA = path.join(__dirname, '..', '..', 'db', 'resumematch_ph.sql');

const PG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || '5432',
  user: process.env.DB_USER || 'postgres',
  pass: process.env.DB_PASS || 'postgres',
};

let server: ChildProcess | null = null;
const sink = new SmtpSink();

function psql(args: string[], db?: string) {
  return execFileSync('psql', [
    '-v', 'ON_ERROR_STOP=1', '-q',
    '-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', db ?? 'postgres', ...args,
  ], { env: { ...process.env, PGPASSWORD: PG.pass }, encoding: 'utf8' });
}

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

/** Pull the 6-digit code out of a captured email. */
function codeFrom(body: string): string {
  const m = /\b(\d{6})\b/.exec(body);
  assert.ok(m, 'no 6-digit code in the email body');
  return m![1];
}

before(async () => {
  const smtpPort = await sink.start();

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
        PORT: String(PORT), SESSION_SECRET: 'email-test-secret',
        // DEBUG off on purpose: with it on, codes come back in the API
        // response and the email path is never needed. This proves delivery.
        DEBUG: 'false',
        SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false',
        SMTP_USER: '', SMTP_PASS: '',
        MAIL_FROM: 'ResumeMatch PH <no-reply@rmph.test>',
        APP_URL: `http://127.0.0.1:${PORT}`,
        GEMINI_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  server.stderr?.on('data', (d) => { const t = String(d); if (/Error|error:/.test(t)) console.error('[server] ' + t.slice(0, 700)); });

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
  await sink.stop();
  try { psql(['-c', `DROP DATABASE IF EXISTS ${DB}`]); } catch { /* best effort */ }
});

// ---------- registration ----------

test('a verification code is actually emailed, and it works', async () => {
  sink.clear();
  const api = client();
  const email = 'newseeker@example.ph';

  const sent = await api('auth/send-code', { email, purpose: 'verify' });
  assert.equal(sent.body.ok, true);
  // With DEBUG off the code must NOT come back in the response.
  assert.equal(sent.body.devCode, undefined, 'the code must never be returned to the client');

  const mail = await sink.waitFor((m) => m.to.includes(email));
  assert.match(mail.subject, /verification code/i);
  assert.ok(mail.from.length > 0, 'a From address must be set');

  // the emailed code is the one that completes registration
  const reg = await api('auth/register', {
    firstName: 'New', lastName: 'Seeker', email, password: 'abcd1234', code: codeFrom(mail.body),
  });
  assert.equal(reg.body.ok, true, 'the emailed code must complete registration');
  assert.equal(reg.body.user.email, email);
});

test('a wrong code does not register an account', async () => {
  sink.clear();
  const api = client();
  const email = 'wrongcode@example.ph';
  await api('auth/send-code', { email, purpose: 'verify' });
  await sink.waitFor((m) => m.to.includes(email));

  const reg = await api('auth/register', { firstName: 'Nope', lastName: 'Here', email, password: 'abcd1234', code: '000000' });
  assert.equal(reg.body.ok, false, 'a guessed code must be refused');
});

// ---------- password reset ----------

test('the password reset code is emailed and resets the password', async () => {
  // Uses its OWN account. Resetting the shared demo seeker's password here
  // silently broke every later test that signs in as them — the restore at
  // the end was never asserted, so the contamination was invisible.
  sink.clear();
  const api = client();
  const email = 'resetme@example.ph';

  await api('auth/send-code', { email, purpose: 'verify' });
  const verify = await sink.waitFor((m) => m.to.includes(email));
  const reg = await api('auth/register', {
    firstName: 'Reset', lastName: 'Me', email, password: 'original123', code: codeFrom(verify.body),
  });
  assert.equal(reg.body.ok, true);

  sink.clear();
  const sent = await api('auth/send-code', { email, purpose: 'reset' });
  assert.equal(sent.body.ok, true);
  const mail = await sink.waitFor((m) => m.to.includes(email));
  assert.match(mail.subject, /reset/i);

  const reset = await api('auth/reset-password', {
    email, code: codeFrom(mail.body), password: 'brandnew123',
  });
  assert.equal(reset.body.ok, true, 'the emailed reset code must work');

  const login = await client()('auth/login', { email, password: 'brandnew123' });
  assert.equal(login.body.ok, true, 'the new password must sign in');

  const old = await client()('auth/login', { email, password: 'original123' });
  assert.equal(old.body.ok, false, 'the old password must stop working');
});

test('a reset request for an unknown address sends nothing but says the same thing', async () => {
  sink.clear();
  const api = client();
  const sent = await api('auth/send-code', { email: 'ghost@nowhere.ph', purpose: 'reset' });
  assert.equal(sent.body.ok, true, 'the reply must not reveal that the account is missing');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(sink.messages.length, 0, 'no email may be sent for an account that does not exist');
});

// ---------- the recruiter lifecycle, end to end ----------

test('a recruiter can be approved and then actually set a password by email', async () => {
  // This is the exact chain that was broken: request-access stored the
  // address as typed, approve copied it verbatim, and send-code looked it up
  // lowercased — so the recruiter waited forever for an email that never sent.
  sink.clear();
  const anon = client();
  const typed = 'HR.Santos@ClarkOutsourcing.PH';          // deliberately mixed case
  const lower = typed.toLowerCase();

  const companies = (await anon('companies/list')).body.companies;
  const req = await anon('auth/request-access', {
    firstName: 'HR', lastName: 'Santos', email: typed, position: 'HR Officer',
    companyId: companies[0].id, note: 'Please add me.',
  });
  assert.equal(req.body.ok, true, 'the access request must be accepted');

  const admin = client();
  const adminLogin = await admin('auth/login', { email: 'admin@demo.ph', password: 'demo123' });
  assert.equal(adminLogin.body.ok, true, 'admin login failed: ' + JSON.stringify(adminLogin.body));
  const reqRes = await admin('admin/requests');
  assert.equal(reqRes.body.ok, true, 'admin/requests failed: ' + JSON.stringify(reqRes.body));
  const pending = reqRes.body.requests;
  const row = pending.find((r: any) => String(r.email).toLowerCase() === lower);
  assert.ok(row, 'the request must appear in the admin panel');

  const approved = await admin('admin/approve', { id: row.id });
  assert.equal(approved.body.ok, true, 'approval must succeed: ' + JSON.stringify(approved.body));

  // now the new recruiter sets a password the only way they are told to
  const hr = client();
  const code = await hr('auth/send-code', { email: typed, purpose: 'reset' });
  assert.equal(code.body.ok, true, 'send-code failed: ' + JSON.stringify(code.body));
  // The approval notice also lands in this inbox — match the reset email
  // specifically, or codeFrom() reads digits out of the wrong message.
  const mail = await sink.waitFor((m) =>
    m.to.some((t) => t.toLowerCase() === lower) && /reset/i.test(m.subject));

  const set = await hr('auth/reset-password', {
    email: typed, code: codeFrom(mail.body), password: 'clark12345',
  });
  assert.equal(set.body.ok, true, 'the approved recruiter must be able to set a password: ' + JSON.stringify(set.body));

  const login = await hr('auth/login', { email: typed, password: 'clark12345' });
  assert.equal(login.body.ok, true, 'and then sign in with the address they typed');
  assert.equal(login.body.user.role, 'recruiter');
});

// ---------- notifications ----------

test('a new application emails the recruiter', async () => {
  sink.clear();
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const resumeId = (await seeker('resumes/list')).body.resumes[0].id;

  // find an opening this seeker has not already applied to
  const open = (await seeker('postings/list')).body.postings;
  const mine = (await seeker('applications/mine')).body.applications.map((a: any) => String(a.postingId));
  const target = open.find((p: any) => !mine.includes(String(p.id)));
  if (!target) return; // nothing left to apply to in the seed data

  const applied = await seeker('applications/apply', { resumeId, postingId: target.id });
  assert.equal(applied.body.ok, true);

  const mail = await sink.waitFor((m) => /applicant|application/i.test(m.subject));
  assert.ok(mail.to.length > 0, 'the notice must be addressed to someone');
  assert.match(mail.body, /Clark|applicant|application/i);
});

test('a status change emails the applicant', async () => {
  sink.clear();
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const postingId = (await hr('postings/mine')).body.postings[0].id;
  const ranked = (await hr('applications/ranked', { postingId })).body.rows;
  if (!ranked?.length) return;

  const app = ranked[0].application;
  const changed = await hr('applications/set-status', { id: app.id, status: 'shortlisted' });
  assert.equal(changed.body.ok, true);

  const mail = await sink.waitFor((m) => /shortlist|update|application/i.test(m.subject));
  assert.ok(mail.to.length > 0);
});

test('an interview invitation reaches the applicant and replies to the recruiter', async () => {
  sink.clear();
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  const postingId = (await hr('postings/mine')).body.postings[0].id;
  const ranked = (await hr('applications/ranked', { postingId })).body.rows;
  if (!ranked?.length) return;

  const sent = await hr('applications/invite', {
    id: ranked[0].application.id,
    message: 'We would like to invite you for an interview this Thursday at 10am. Please confirm.',
  });
  assert.equal(sent.body.ok, true, 'the invitation must send: ' + JSON.stringify(sent.body));

  const mail = await sink.waitFor((m) => /interview|invit/i.test(m.subject + m.body));
  assert.match(mail.body, /Thursday/, 'the recruiter’s own words must reach the applicant');
  // the conversation must continue with the recruiter, not the no-reply address
  assert.match(mail.raw, /Reply-To:/i, 'an interview invitation needs a Reply-To');
});

test('a new posting alerts seekers whose resume matches', async () => {
  sink.clear();
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });

  const created = await hr('postings/save', {
    posting: {
      title: 'Customer Support Agent (alert test)',
      department: 'Customer Support',
      description: 'Greet guests, manage check-in and check-out, and handle enquiries at the desk.',
      skills: ['Customer Service', 'Communication', 'CRM Software'],
      educationLevel: 'highschool',
      minExperienceMonths: 0,
      employmentType: 'full-time',
    },
  });
  assert.equal(created.body.ok, true, 'the posting must save');

  // alerts are fire-and-forget; give them a moment
  const mail = await sink.waitFor((m) => /opening|match|posting/i.test(m.subject), 10000);
  assert.ok(mail.to.length > 0, 'at least one matching seeker must be alerted');
});

test('nothing is emailed to a seeker who turned notifications off', async () => {
  const seeker = client();
  await seeker('auth/login', { email: 'seeker@demo.ph', password: 'demo123' });
  const off = await seeker('auth/set-notifications', { enabled: false });
  assert.equal(off.body.ok, true);

  sink.clear();
  const hr = client();
  await hr('auth/login', { email: 'hr@demo.ph', password: 'demo123' });
  await hr('postings/save', {
    posting: {
      title: 'Housekeeping Attendant (opt-out test)',
      department: 'Housekeeping',
      description: 'Clean and prepare guest rooms to the hotel standard each shift.',
      skills: ['Housekeeping', 'Time Management'],
      educationLevel: 'highschool', minExperienceMonths: 0, employmentType: 'full-time',
    },
  });
  await new Promise((r) => setTimeout(r, 2500));

  const toOptedOut = sink.messages.filter((m) => m.to.includes('seeker@demo.ph'));
  assert.equal(toOptedOut.length, 0, 'a seeker who opted out must receive nothing');

  await seeker('auth/set-notifications', { enabled: true });
});
