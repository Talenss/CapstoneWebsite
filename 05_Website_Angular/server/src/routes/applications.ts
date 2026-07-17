/* ResumeMatch PH — routes/applications.ts : apply · mine · ranked · set-status */
import { Router } from 'express';
import { query, queryOne, exec } from '../db';
import { ApplicationRow } from '../types';
import { ok, fail } from '../lib/http';
import { requireRole, requireUser } from '../lib/auth';
import { fetchResume, fetchPosting, serializeResume, serializePosting, serializeApplication } from '../lib/serializers';
import { rmScore, cacheScore } from '../lib/engine';

const router = Router();

router.post('/apply', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const rid = Number(req.body?.resumeId);
  const pid = Number(req.body?.postingId);

  const r = await fetchResume(rid);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Choose one of your own resumes.');

  const p = await fetchPosting(pid);
  if (!p) return fail(res, 'That opening no longer exists.');
  if (p.status !== 'open') return fail(res, 'This opening is closed.');

  const dup = await queryOne('SELECT 1 FROM applications WHERE seeker_id=? AND posting_id=? LIMIT 1', [u.user_id, pid]);
  if (dup) return fail(res, 'You already applied to this position.');

  // record the score AS IT WAS at the moment of applying
  const s = await rmScore(await serializeResume(r), await serializePosting(p, false));

  const { insertId } = await exec(
    'INSERT INTO applications (seeker_id, resume_id, posting_id, status, score_snapshot) VALUES (?,?,?,"submitted",?)',
    [u.user_id, rid, pid, s.score],
  );
  await exec(
    'INSERT INTO application_status_history (application_id, old_status, new_status, changed_by) VALUES (?,NULL,"submitted",?)',
    [insertId, u.user_id],
  );
  await cacheScore(rid, pid, s);

  const app = await queryOne<ApplicationRow>('SELECT * FROM applications WHERE application_id = ?', [insertId]);
  ok(res, { application: serializeApplication(app!) });
});

router.post('/mine', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const rows = await query<ApplicationRow>('SELECT * FROM applications WHERE seeker_id = ? ORDER BY applied_at DESC', [u.user_id]);

  const out = [];
  for (const a of rows) {
    const row: any = serializeApplication(a);
    const p = await fetchPosting(a.posting_id);
    if (p) {
      const full = await serializePosting(p);
      row.posting = full;
      row.company = full.company ?? null;
    }
    const r = await fetchResume(a.resume_id);
    row.resumeTitle = r ? r.title : null;
    out.push(row);
  }
  ok(res, { applications: out });
});

/* THE RANKED SHORTLIST.
   Sorted by score — but never FILTERED by it. Everyone who applied
   is returned. The recruiter's own filters are the only thing that
   ever hides anyone, and they can always be cleared.              */
router.post('/ranked', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const pid = Number(req.body?.postingId);
  const p = await fetchPosting(pid);
  if (!p || p.company_id !== u.company_id) return fail(res, 'Opening not found.');

  const posting = await serializePosting(p);

  const rows = await query<any>(
    `SELECT a.*, u.user_id AS s_id, u.full_name AS s_name, u.email AS s_email
       FROM applications a
       JOIN users u ON u.user_id = a.seeker_id
      WHERE a.posting_id = ?`, [pid],
  );

  const out: any[] = [];
  for (const a of rows) {
    const r = await fetchResume(a.resume_id);
    if (!r) continue;
    const resume = await serializeResume(r);
    const s = await rmScore(resume, posting);
    await cacheScore(a.resume_id, pid, s);

    out.push({
      ...s,
      application: serializeApplication(a),
      resume,
      seeker: { id: String(a.s_id), name: a.s_name, email: a.s_email, role: 'seeker' },
    });
  }

  out.sort((x, y) => y.score - x.score || x.application.appliedAt - y.application.appliedAt);

  ok(res, { posting, rows: out });
});

/* Every status change is a HUMAN decision, and it is recorded as one. */
router.post('/set-status', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const aid = Number(req.body?.id);
  const status = String(req.body?.status ?? '');

  if (!['submitted', 'review', 'shortlisted', 'rejected', 'hired'].includes(status)) return fail(res, 'Unknown status.');

  const a = await queryOne<ApplicationRow & { company_id: number }>(
    `SELECT a.*, p.company_id
       FROM applications a
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE a.application_id = ?`, [aid],
  );
  if (!a || a.company_id !== u.company_id) return fail(res, 'Application not found.');

  await exec('UPDATE applications SET status = ? WHERE application_id = ?', [status, aid]);
  await exec(
    'INSERT INTO application_status_history (application_id, old_status, new_status, changed_by) VALUES (?,?,?,?)',
    [aid, a.status, status, u.user_id],
  );

  const updated = await queryOne<ApplicationRow>('SELECT * FROM applications WHERE application_id = ?', [aid]);
  ok(res, { application: serializeApplication(updated!) });
});

export default router;
