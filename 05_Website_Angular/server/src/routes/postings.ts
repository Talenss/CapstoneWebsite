/* ResumeMatch PH — routes/postings.ts : list · mine · get · save · toggle */
import { Router } from 'express';
import { query, queryOne, exec, withTransaction } from '../db';
import { PostingRow, UserRow, ResumeRow } from '../types';
import { ok, fail } from '../lib/http';
import { requireRole } from '../lib/auth';
import { fetchPosting, fetchResume, serializePosting, serializeResume } from '../lib/serializers';
import { EDU_RANK, skillId, rmScore, getSettings } from '../lib/engine';
import { notifyNewPostingMatch } from '../lib/notify';

const router = Router();

// Public: every open position still accepting applications (a past
// application deadline hides a posting without anyone closing it).
router.post('/list', async (_req, res) => {
  const rows = await query<PostingRow>(
    `SELECT * FROM job_postings
      WHERE status='open' AND (application_deadline IS NULL OR application_deadline >= CURRENT_DATE)
      ORDER BY created_at DESC`,
  );
  ok(res, { postings: await Promise.all(rows.map((p) => serializePosting(p))) });
});

/** Job alerts: score the brand-new posting against every seeker's ACTIVE
 *  resume and email the ones it fits (possible tier or better). Runs
 *  fire-and-forget after the posting is created. */
async function alertMatchingSeekers(postingId: number): Promise<void> {
  const p = await fetchPosting(postingId);
  if (!p || p.status !== 'open') return;
  const posting = await serializePosting(p);
  const companyName = posting.company?.name || 'Our partner company';
  const T = (await getSettings()).thresholds;

  const seekers = await query<UserRow>(
    `SELECT * FROM users
      WHERE role='seeker' AND email_notifications=1 AND active_resume_id IS NOT NULL`,
  );
  for (const s of seekers) {
    try {
      const r = await fetchResume(s.active_resume_id!);
      if (!r) continue;
      const score = await rmScore(await serializeResume(r as ResumeRow), posting);
      if (score.score < T.related) continue; // below "possible" — no alert
      await notifyNewPostingMatch(s.email, s.full_name, p.title, companyName, score.score, score.tier);
    } catch (e: any) {
      console.error('job alert failed for', s.email, '-', e?.message || e);
    }
  }
}

// Recruiter: every posting of MY company, open or closed, with counts.
router.post('/mine', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const rows = await query<PostingRow>('SELECT * FROM job_postings WHERE company_id = ? ORDER BY created_at DESC', [u.company_id]);

  const out = [];
  for (const p of rows) {
    const row = await serializePosting(p);
    const n = await queryOne<{ total: number; fresh: number }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'submitted') AS fresh FROM applications WHERE posting_id = ?`, [p.posting_id],
    );
    row.applicantCount = Number(n?.total ?? 0);
    row.newCount = Number(n?.fresh ?? 0);
    out.push(row);
  }
  ok(res, { postings: out });
});

router.post('/get', async (req, res) => {
  const p = await fetchPosting(Number(req.body?.id));
  if (!p) return fail(res, 'That opening no longer exists.');
  ok(res, { posting: await serializePosting(p) });
});

router.post('/save', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const P = req.body?.posting;
  if (!P || typeof P !== 'object') return fail(res, 'Nothing to save.');

  const title = String(P.title ?? '').trim();
  const dept = String(P.department ?? '').trim();
  const desc = String(P.description ?? '').trim();
  const skills = (Array.isArray(P.skills) ? P.skills : []).map((s: any) => String(s).trim()).filter(Boolean);

  if (title.length < 2) return fail(res, 'Give the opening a title.');
  if (dept === '') return fail(res, 'Which department is this for?');
  if (desc.length < 10) return fail(res, 'Describe the role in a sentence or two.');
  if (!skills.length) return fail(res, "Add at least one required skill — it's half the score.");

  const edu = Object.keys(EDU_RANK).includes(P.educationLevel) ? P.educationLevel : 'bachelor';
  const type = ['full-time', 'part-time', 'contract', 'internship'].includes(P.employmentType) ? P.employmentType : 'full-time';
  const months = Math.max(0, Number(P.minExperienceMonths) || 0);

  // Optional "apply by" date. Must be today or later when set.
  let deadline: string | null = null;
  if (P.deadline) {
    const d = String(P.deadline).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return fail(res, 'The application deadline looks wrong — use the date picker.');
    if (d < new Date().toISOString().slice(0, 10)) return fail(res, "The application deadline can't be in the past.");
    deadline = d;
  }

  // Ownership check up front so edits to another company's opening get a
  // clean 403 rather than a generic transaction 500.
  if (P.id) {
    const own = await queryOne<PostingRow>('SELECT company_id FROM job_postings WHERE posting_id = ?', [Number(P.id)]);
    if (!own || own.company_id !== u.company_id) return fail(res, "You can only edit your own company's openings.", 403);
  }

  try {
    const id = await withTransaction(async (tx) => {
      let pid = P.id ? Number(P.id) : 0;

      if (pid) {
        await tx.exec(
          'UPDATE job_postings SET title=?, department=?, employment_type=?, description=?, education_level=?, min_experience_months=?, application_deadline=? WHERE posting_id=?',
          [title, dept, type, desc, edu, months, deadline, pid],
        );
      } else {
        const ins = await tx.exec(
          `INSERT INTO job_postings (company_id, created_by, title, department, employment_type, description, education_level, min_experience_months, application_deadline, status)
           VALUES (?,?,?,?,?,?,?,?,?,'open') RETURNING posting_id`,
          [u.company_id, u.user_id, title, dept, type, desc, edu, months, deadline],
        );
        pid = ins.insertId;
      }

      await tx.exec('DELETE FROM posting_skills WHERE posting_id = ?', [pid]);
      for (const s of skills) {
        const sid = await skillId(s);
        await tx.exec('INSERT INTO posting_skills (posting_id, skill_id) VALUES (?,?) ON CONFLICT DO NOTHING', [pid, sid]);
      }
      return pid;
    });

    // Brand-new opening → job alerts for seekers whose active resume fits.
    if (!P.id) alertMatchingSeekers(id).catch((e) => console.error('job alerts failed:', e?.message || e));

    const saved = await fetchPosting(id);
    ok(res, { posting: await serializePosting(saved!) });
  } catch (e) {
    fail(res, "The opening couldn't be saved. Try again.", 500);
  }
});

// Closing an opening stops NEW applications. It never removes the
// people who already applied — they stay on the ranked list.
router.post('/toggle', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const id = Number(req.body?.id);
  const p = await fetchPosting(id);
  if (!p || p.company_id !== u.company_id) return fail(res, 'Opening not found.');

  const next = p.status === 'open' ? 'closed' : 'open';
  await exec('UPDATE job_postings SET status = ? WHERE posting_id = ?', [next, id]);
  ok(res, { posting: await serializePosting((await fetchPosting(id))!) });
});

export default router;
