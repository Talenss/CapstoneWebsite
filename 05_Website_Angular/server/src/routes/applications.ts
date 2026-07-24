/* ResumeMatch PH — routes/applications.ts : apply · mine · ranked · set-status */
import { Router } from 'express';
import { query, queryOne, exec } from '../db';
import { ApplicationRow } from '../types';
import { ok, fail } from '../lib/http';
import { requireRole, requireUser } from '../lib/auth';
import { fetchResume, fetchPosting, postingExpired, serializeResume, serializePosting, serializeApplication } from '../lib/serializers';
import { rmScore, cacheScore } from '../lib/engine';
import { notifyStatusChange, notifyNewApplication, sendInterviewInvite } from '../lib/notify';
import { UserRow } from '../types';

const router = Router();

/** Decide who is emailed about a new application, then send it.
 *  Department has an assigned HR owner → only that person is emailed (nobody
 *  else). Department has no owner → every verified recruiter is emailed (the
 *  safe fallback). The email_notifications opt-out is always respected, so a
 *  muted recruiter is skipped either way. This only picks the email
 *  recipient(s); who can *see* the applicant is unchanged. */
async function routeNewApplication(
  companyId: number,
  department: string | null,
  postingTitle: string,
  seekerName: string,
  score: number,
): Promise<void> {
  const dept = (department ?? '').trim();
  const owner = dept
    ? await queryOne<UserRow>(
        `SELECT u.* FROM department_assignments da
           JOIN users u ON u.user_id = da.user_id
          WHERE da.company_id = ? AND LOWER(TRIM(da.department)) = LOWER(?)
            AND u.role = 'recruiter' AND u.verified = 1
          LIMIT 1`,
        [companyId, dept],
      )
    : null;

  const targets = owner
    ? [owner]
    : await query<UserRow>(
        `SELECT * FROM users
          WHERE role = 'recruiter' AND company_id = ? AND verified = 1`,
        [companyId],
      );

  await Promise.all(
    targets
      .filter((r) => r.email_notifications)
      .map((r) =>
        notifyNewApplication(r.email, r.full_name, postingTitle, seekerName, score)
          .catch((e) => console.error('new-application notify failed:', e?.message || e)),
      ),
  );
}

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
  if (postingExpired(p)) return fail(res, 'The application deadline for this opening has passed.');

  const dup = await queryOne('SELECT 1 FROM applications WHERE seeker_id=? AND posting_id=? LIMIT 1', [u.user_id, pid]);
  if (dup) return fail(res, 'You already applied to this position.');

  // record the score AS IT WAS at the moment of applying
  const s = await rmScore(await serializeResume(r), await serializePosting(p, false));

  const { insertId } = await exec(
    "INSERT INTO applications (seeker_id, resume_id, posting_id, status, score_snapshot) VALUES (?,?,?,'submitted',?) RETURNING application_id",
    [u.user_id, rid, pid, s.score],
  );
  await exec(
    "INSERT INTO application_status_history (application_id, old_status, new_status, changed_by) VALUES (?,NULL,'submitted',?)",
    [insertId, u.user_id],
  );
  await cacheScore(rid, pid, s);

  // Route the "new applicant" email by department. If an HR person owns this
  // posting's department, the notice goes straight to them (nobody else is
  // emailed). If the department has no owner, every verified recruiter hears
  // about it — the safe default, so an application is never silently lost.
  // Either way the applicant stays visible in every recruiter's list; this
  // only decides who gets the email. Fire-and-forget — a mail failure must
  // never fail the application.
  routeNewApplication(p.company_id, p.department, p.title, u.full_name, s.score)
    .catch((e) => console.error('new-application notify failed:', e?.message || e));

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

  // Tell the seeker — unless they opted out, nothing actually changed, or
  // the "change" is back to submitted (their own starting state).
  if (status !== a.status && status !== 'submitted') {
    (async () => {
      const seeker = await queryOne<UserRow>(
        'SELECT * FROM users WHERE user_id = ? AND email_notifications = 1', [a.seeker_id]);
      if (!seeker) return;
      const p = await fetchPosting(a.posting_id);
      if (!p) return;
      const co = await queryOne<{ company_name: string }>(
        'SELECT company_name FROM companies WHERE company_id = ?', [p.company_id]);
      await notifyStatusChange(seeker.email, seeker.full_name, p.title, co?.company_name || 'the company', status);
    })().catch((e) => console.error('status notify failed:', e?.message || e));
  }

  const updated = await queryOne<ApplicationRow>('SELECT * FROM applications WHERE application_id = ?', [aid]);
  ok(res, { application: serializeApplication(updated!) });
});

/* A recruiter's personal message to an applicant — typically the
   interview invitation after shortlisting. Deliberately transactional:
   it is one human writing to another about an application the seeker
   chose to submit, so the marketing-style opt-out doesn't apply. The
   reply-to is the recruiter, so the conversation continues over email. */
router.post('/invite', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const aid = Number(req.body?.id);
  const message = String(req.body?.message ?? '').trim();
  if (message.length < 10) return fail(res, 'Write the applicant a short message first.');
  if (message.length > 2000) return fail(res, 'Keep the message under 2000 characters.');

  const a = await queryOne<ApplicationRow & { company_id: number }>(
    `SELECT a.*, p.company_id
       FROM applications a
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE a.application_id = ?`, [aid],
  );
  if (!a || a.company_id !== u.company_id) return fail(res, 'Application not found.');

  const seeker = await queryOne<UserRow>('SELECT * FROM users WHERE user_id = ?', [a.seeker_id]);
  const p = await fetchPosting(a.posting_id);
  if (!seeker || !p) return fail(res, 'Application not found.');
  const co = await queryOne<{ company_name: string }>(
    'SELECT company_name FROM companies WHERE company_id = ?', [p.company_id]);

  const sent = await sendInterviewInvite(
    seeker.email, seeker.full_name, u.full_name, u.email,
    p.title, co?.company_name || 'the company', message,
  );
  if (!sent.ok) return fail(res, sent.error);
  ok(res, { sent: sent.sent });
});

export default router;
