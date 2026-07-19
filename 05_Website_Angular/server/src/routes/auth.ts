/* ResumeMatch PH — routes/auth.ts
   Port of api/auth.php: login · register · request-access · logout · me
   · change-password · delete-account · export (RA 10173 right of access) */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { query, queryOne, exec } from '../db';
import { UserRow, ResumeRow, ApplicationRow } from '../types';
import { ok, fail } from '../lib/http';
import { currentUser, requireUser } from '../lib/auth';
import { serializeUser, serializeResume, serializeApplication } from '../lib/serializers';
import { UPLOAD_DIR, DEBUG } from '../config';
import { mailConfigured, sendCodeEmail, sendMail, CodePurpose } from '../lib/mailer';
import { issueCode, checkCode } from '../lib/email-codes';
import { passwordProblem } from '../lib/password';
import { loginLimiter, sendCodeLimiter, authWriteLimiter } from '../lib/rate-limit';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Compared against when the email has no account, so "user not found" and
// "wrong password" take the same time — no timing-based email discovery.
const DUMMY_HASH = bcrypt.hashSync('rmph-timing-equalizer', 10);

/* ---- Email codes: one endpoint issues them for both purposes. ----
   'verify'  — sign-up: the email must NOT have an account yet. If it does,
               the client shows the familiar “log in instead?” prompt
               (exists: true in the response drives that).
   'reset'   — forgot password: never reveals whether an account exists;
               the answer is the same either way, and a code is only
               actually sent when there is an account behind the email. */
router.post('/send-code', sendCodeLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const purpose = String(req.body?.purpose ?? '') as CodePurpose;
  if (!EMAIL_RE.test(email)) return fail(res, 'Enter a valid email address.');
  if (purpose !== 'verify' && purpose !== 'reset') return fail(res, 'Unknown code purpose.');

  const account = await queryOne('SELECT 1 FROM users WHERE email = ? LIMIT 1', [email]);
  if (purpose === 'verify' && account)
    return res.json({ ok: false, exists: true, error: 'This email already has an account.' });
  if (purpose === 'reset' && !account)
    return ok(res, { sent: true }); // same reply as success — no account enumeration

  const issued = await issueCode(email, purpose);
  if (!issued.ok) return fail(res, issued.error);

  if (mailConfigured()) {
    try {
      await sendCodeEmail(email, issued.code, purpose);
    } catch (e: any) {
      console.error('SMTP send failed:', e?.message || e);
      return fail(res, 'The email could not be sent right now. Try again in a moment.');
    }
    return ok(res, { sent: true });
  }

  // No SMTP configured. In development the code is surfaced on the server
  // console (and echoed to the client) so the flow stays testable; in
  // production the honest answer is that email isn't set up.
  if (DEBUG) {
    console.log(`[email-codes] DEBUG — code for ${email} (${purpose}): ${issued.code}`);
    return ok(res, { sent: false, devCode: issued.code, note: 'SMTP is not configured; DEBUG mode returned the code directly.' });
  }
  return fail(res, "Email sending isn't configured on this server. Contact the site administrators.");
});

router.post('/reset-password', authWriteLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const code = String(req.body?.code ?? '').trim();
  const pass = String(req.body?.password ?? '');
  if (!EMAIL_RE.test(email)) return fail(res, 'Enter a valid email address.');
  const pwErr = passwordProblem(pass);
  if (pwErr) return fail(res, pwErr);

  const u = await queryOne<UserRow>('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  // The generic message matches the 'reset' send-code reply: neither
  // confirms whether the email has an account.
  if (!u) return fail(res, "That code isn't right. Check the email and try again.");

  const check = await checkCode(email, 'reset', code);
  if (!check.ok) return fail(res, check.error);

  await exec('UPDATE users SET password_hash = ? WHERE user_id = ?', [await bcrypt.hash(pass, 10), u.user_id]);
  ok(res);
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  const pass = String(req.body?.password ?? '');
  if (!email || !pass) return fail(res, 'Enter your email and password.');

  const u = await queryOne<UserRow>('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);

  // Same message — and same bcrypt cost — either way: never reveal
  // whether an email exists, not even by response time. The 401 status
  // also lets the rate limiter count exactly the FAILED attempts.
  const passOk = await bcrypt.compare(pass, u ? u.password_hash : DUMMY_HASH);
  if (!u || !passOk)
    return fail(res, "That email and password don't match an account.", 401);

  if (u.role === 'recruiter' && !u.verified)
    return fail(res, "This recruiter account isn't active yet. Accounts are activated by the research team together with the partner company's HR.", 403);

  req.session.regenerate(async (err) => {
    if (err) return fail(res, 'Login failed. Try again.', 500);
    req.session.uid = u.user_id;
    await exec('UPDATE users SET last_login_at = NOW() WHERE user_id = ?', [u.user_id]);
    ok(res, { user: serializeUser(u) });
  });
});

router.post('/register', authWriteLimiter, async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const pass = String(req.body?.password ?? '');
  const code = String(req.body?.code ?? '').trim();

  if (name.length < 2) return fail(res, 'Enter your full name.');
  if (!EMAIL_RE.test(email)) return fail(res, 'Enter a valid email address.');
  const pwErr = passwordProblem(pass);
  if (pwErr) return fail(res, pwErr);

  const exists = await queryOne('SELECT 1 FROM users WHERE email = ? LIMIT 1', [email]);
  if (exists) return res.json({ ok: false, exists: true, error: 'An account already uses this email. Log in instead.' });

  // The account only comes into being once the emailed code checks out —
  // so every registered email is a verified email.
  const check = await checkCode(email, 'verify', code);
  if (!check.ok) return fail(res, check.error);

  const hash = await bcrypt.hash(pass, 10);
  const { insertId } = await exec(
    'INSERT INTO users (role, full_name, email, password_hash) VALUES (?,?,?,?) RETURNING user_id',
    ['seeker', name, email, hash],
  );

  req.session.regenerate(async (err) => {
    if (err) return fail(res, 'Registration failed. Try again.', 500);
    req.session.uid = insertId;
    const u = await queryOne<UserRow>('SELECT * FROM users WHERE user_id = ?', [insertId]);
    ok(res, { user: serializeUser(u) });
  });
});

// Recruiters do NOT self-register. A request lands here and a human
// approves it with the partner company's HR before it becomes an account.
router.post('/request-access', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim();
  const pos = String(req.body?.position ?? '').trim();
  const co = req.body?.companyId;
  const note = String(req.body?.note ?? '').trim();

  if (name.length < 2) return fail(res, 'Enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 'Enter a valid email address.');
  if (pos === '') return fail(res, 'Enter your position.');
  if (!co) return fail(res, 'Choose your partner company.');

  const exists = await queryOne('SELECT 1 FROM users WHERE email = ? LIMIT 1', [email]);
  if (exists) return fail(res, 'An account already uses this email.');

  const pending = await queryOne(
    "SELECT 1 FROM recruiter_requests WHERE email = ? AND status = 'pending' LIMIT 1", [email],
  );
  if (pending) return fail(res, 'A request from this email is already waiting for review.');

  await exec(
    'INSERT INTO recruiter_requests (full_name, email, position_title, company_id, note) VALUES (?,?,?,?,?)',
    [name, email, pos, Number(co), note],
  );
  ok(res);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('rmph.sid');
    ok(res);
  });
});

router.post('/me', async (req, res) => {
  ok(res, { user: serializeUser(await currentUser(req)) });
});

/** Toggle application-event emails (status changes for seekers, new
 *  applicants for recruiters). Security-code emails are unaffected —
 *  they only ever arrive when the user asks for one. */
router.post('/set-notifications', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const enabled = req.body?.enabled ? 1 : 0;
  await exec('UPDATE users SET email_notifications = ? WHERE user_id = ?', [enabled, u.user_id]);
  const updated = await queryOne<UserRow>('SELECT * FROM users WHERE user_id = ?', [u.user_id]);
  ok(res, { user: serializeUser(updated) });
});

/* ---- Change email: same proof-of-inbox flow as registration. ----
   Step 1 checks the password and emails a code to the NEW address;
   step 2 confirms the code and switches the account over, with a
   courtesy security notice to the old address. */
router.post('/change-email-start', sendCodeLimiter, async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const newEmail = String(req.body?.newEmail ?? '').trim().toLowerCase();
  const pass = String(req.body?.password ?? '');

  if (!EMAIL_RE.test(newEmail)) return fail(res, 'Enter a valid email address.');
  if (newEmail === u.email.toLowerCase()) return fail(res, 'That is already your email address.');
  if (!(await bcrypt.compare(pass, u.password_hash))) return fail(res, 'Your password is incorrect.');

  const taken = await queryOne('SELECT 1 FROM users WHERE email = ? LIMIT 1', [newEmail]);
  if (taken) return fail(res, 'Another account already uses that email.');

  const issued = await issueCode(newEmail, 'verify');
  if (!issued.ok) return fail(res, issued.error);

  if (mailConfigured()) {
    try {
      await sendCodeEmail(newEmail, issued.code, 'verify');
    } catch (e: any) {
      console.error('SMTP send failed:', e?.message || e);
      return fail(res, 'The email could not be sent right now. Try again in a moment.');
    }
    return ok(res, { sent: true });
  }
  if (DEBUG) {
    console.log(`[email-codes] DEBUG — change-email code for ${newEmail}: ${issued.code}`);
    return ok(res, { sent: false, devCode: issued.code, note: 'SMTP is not configured; DEBUG mode returned the code directly.' });
  }
  return fail(res, "Email sending isn't configured on this server. Contact the site administrators.");
});

router.post('/change-email-confirm', authWriteLimiter, async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const newEmail = String(req.body?.newEmail ?? '').trim().toLowerCase();
  const code = String(req.body?.code ?? '').trim();
  if (!EMAIL_RE.test(newEmail)) return fail(res, 'Enter a valid email address.');

  const taken = await queryOne('SELECT 1 FROM users WHERE email = ? LIMIT 1', [newEmail]);
  if (taken) return fail(res, 'Another account already uses that email.');

  const check = await checkCode(newEmail, 'verify', code);
  if (!check.ok) return fail(res, check.error);

  const oldEmail = u.email;
  await exec('UPDATE users SET email = ? WHERE user_id = ?', [newEmail, u.user_id]);

  if (mailConfigured()) {
    sendMail(
      oldEmail,
      'Your ResumeMatch PH email address was changed',
      `Security notice\n\nThe email on your account was changed to ${newEmail}. If this was you, no action is needed. If it wasn't, contact the research team through the School of Computing immediately.`,
      `
        <h1 style="margin:0 0 10px;font-size:22px">Security notice</h1>
        <p style="margin:0;font-size:14.5px;line-height:1.65;color:#4C5566">The email address on your ResumeMatch PH account was changed to <b>${newEmail}</b>. If this was you, no action is needed. If it wasn’t, contact the research team through the School of Computing immediately — your password still protects the account.</p>`,
    ).catch((e) => console.error('change-email notice failed:', e?.message || e));
  } else if (DEBUG) {
    console.log(`[auth] email changed: ${oldEmail} -> ${newEmail}`);
  }

  const updated = await queryOne<UserRow>('SELECT * FROM users WHERE user_id = ?', [u.user_id]);
  ok(res, { user: serializeUser(updated) });
});

router.post('/change-password', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const cur = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');

  if (!(await bcrypt.compare(cur, u.password_hash))) return fail(res, 'Your current password is incorrect.');
  const pwErr = passwordProblem(next);
  if (pwErr) return fail(res, pwErr);

  await exec('UPDATE users SET password_hash = ? WHERE user_id = ?', [await bcrypt.hash(next, 10), u.user_id]);
  ok(res);
});

// RA 10173, right of erasure. FK cascades take the resumes,
// applications, and skill links with it.
router.post('/delete-account', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  if (!(await bcrypt.compare(String(req.body?.password ?? ''), u.password_hash)))
    return fail(res, 'Password is incorrect.');

  const files = await query<{ own_file_path: string }>(
    'SELECT own_file_path FROM resumes WHERE user_id = ? AND own_file_path IS NOT NULL', [u.user_id],
  );
  for (const row of files) {
    const p = path.join(UPLOAD_DIR, path.basename(row.own_file_path));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  await exec('UPDATE users SET active_resume_id = NULL WHERE user_id = ?', [u.user_id]);
  await exec('DELETE FROM users WHERE user_id = ?', [u.user_id]);

  req.session.destroy(() => {
    res.clearCookie('rmph.sid');
    ok(res);
  });
});

// RA 10173, right of access. Everything we hold on this person.
router.post('/export', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;

  const resumeRows = await query<ResumeRow>('SELECT * FROM resumes WHERE user_id = ?', [u.user_id]);
  const resumes = await Promise.all(resumeRows.map(serializeResume));

  const appRows = await query<ApplicationRow>('SELECT * FROM applications WHERE seeker_id = ?', [u.user_id]);
  const applications = appRows.map(serializeApplication);

  ok(res, {
    data: {
      exportedAt: new Date().toISOString(),
      account: serializeUser(u),
      resumes,
      applications,
      note: 'Uploaded resume files download separately from My resumes.',
    },
  });
});

export default router;
