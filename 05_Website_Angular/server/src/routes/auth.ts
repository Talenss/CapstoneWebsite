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
import { UPLOAD_DIR } from '../config';

const router = Router();

router.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  const pass = String(req.body?.password ?? '');
  if (!email || !pass) return fail(res, 'Enter your email and password.');

  const u = await queryOne<UserRow>('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);

  // Same message either way — never reveal whether an email exists.
  if (!u || !(await bcrypt.compare(pass, u.password_hash)))
    return fail(res, "That email and password don't match an account.");

  if (u.role === 'recruiter' && !u.verified)
    return fail(res, "This recruiter account isn't active yet. Accounts are activated by the research team together with the partner company's HR.");

  req.session.regenerate(async (err) => {
    if (err) return fail(res, 'Login failed. Try again.', 500);
    req.session.uid = u.user_id;
    await exec('UPDATE users SET last_login_at = NOW() WHERE user_id = ?', [u.user_id]);
    ok(res, { user: serializeUser(u) });
  });
});

router.post('/register', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim();
  const pass = String(req.body?.password ?? '');

  if (name.length < 2) return fail(res, 'Enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 'Enter a valid email address.');
  if (pass.length < 6) return fail(res, 'Use a password of at least 6 characters.');

  const exists = await queryOne('SELECT 1 FROM users WHERE email = ? LIMIT 1', [email]);
  if (exists) return fail(res, 'An account already uses this email. Log in instead.');

  const hash = await bcrypt.hash(pass, 10);
  const { insertId } = await exec(
    'INSERT INTO users (role, full_name, email, password_hash) VALUES (?,?,?,?)',
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

router.post('/change-password', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const cur = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');

  if (!(await bcrypt.compare(cur, u.password_hash))) return fail(res, 'Your current password is incorrect.');
  if (next.length < 6) return fail(res, 'Use a password of at least 6 characters.');

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
