/* ResumeMatch PH — routes/postings.ts : list · mine · get · save · toggle */
import { Router } from 'express';
import { query, queryOne, exec, db } from '../db';
import { PostingRow } from '../types';
import { ok, fail } from '../lib/http';
import { requireRole } from '../lib/auth';
import { fetchPosting, serializePosting } from '../lib/serializers';
import { EDU_RANK, skillId } from '../lib/engine';

const router = Router();

// Public: every open position. Browsing needs no account.
router.post('/list', async (_req, res) => {
  const rows = await query<PostingRow>("SELECT * FROM job_postings WHERE status='open' ORDER BY created_at DESC");
  ok(res, { postings: await Promise.all(rows.map((p) => serializePosting(p))) });
});

// Recruiter: every posting of MY company, open or closed, with counts.
router.post('/mine', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const rows = await query<PostingRow>('SELECT * FROM job_postings WHERE company_id = ? ORDER BY created_at DESC', [u.company_id]);

  const out = [];
  for (const p of rows) {
    const row = await serializePosting(p);
    const n = await queryOne<{ total: number; fresh: number }>(
      `SELECT COUNT(*) AS total, SUM(status = 'submitted') AS fresh FROM applications WHERE posting_id = ?`, [p.posting_id],
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

  const conn = await db().getConnection();
  try {
    await conn.beginTransaction();
    let id = P.id ? Number(P.id) : 0;

    if (id) {
      const [ownRows]: any = await conn.query('SELECT * FROM job_postings WHERE posting_id=?', [id]);
      const own = ownRows[0];
      if (!own || own.company_id !== u.company_id) {
        await conn.rollback();
        return fail(res, "You can only edit your own company's openings.", 403);
      }
      await conn.query(
        'UPDATE job_postings SET title=?, department=?, employment_type=?, description=?, education_level=?, min_experience_months=? WHERE posting_id=?',
        [title, dept, type, desc, edu, months, id],
      );
    } else {
      const [insResult]: any = await conn.query(
        `INSERT INTO job_postings (company_id, created_by, title, department, employment_type, description, education_level, min_experience_months, status)
         VALUES (?,?,?,?,?,?,?,?,"open")`,
        [u.company_id, u.user_id, title, dept, type, desc, edu, months],
      );
      id = insResult.insertId;
    }

    await conn.query('DELETE FROM posting_skills WHERE posting_id = ?', [id]);
    for (const s of skills) {
      const sid = await skillId(s);
      await conn.query('INSERT IGNORE INTO posting_skills (posting_id, skill_id) VALUES (?,?)', [id, sid]);
    }

    await conn.commit();
    const saved = await fetchPosting(id);
    ok(res, { posting: await serializePosting(saved!) });
  } catch (e) {
    await conn.rollback();
    fail(res, "The opening couldn't be saved. Try again.", 500);
  } finally {
    conn.release();
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
