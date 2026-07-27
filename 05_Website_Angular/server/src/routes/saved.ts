/* ResumeMatch PH — routes/saved.ts : a seeker's bookmarked openings. */
import { asyncRouter } from '../lib/async-router';
import { query, queryOne, exec } from '../db';
import { PostingRow } from '../types';
import { ok, fail } from '../lib/http';
import { requireRole } from '../lib/auth';
import { serializePosting } from '../lib/serializers';

const router = asyncRouter();

router.post('/list', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const rows = await query<PostingRow>(
    `SELECT p.* FROM saved_jobs s JOIN job_postings p ON p.posting_id = s.posting_id
      WHERE s.user_id = ? ORDER BY s.created_at DESC`, [u.user_id],
  );
  ok(res, { postings: await Promise.all(rows.map((p) => serializePosting(p))) });
});

router.post('/toggle', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const pid = Number(req.body?.postingId);
  if (!Number.isInteger(pid) || pid <= 0) return fail(res, 'Opening not found.');

  // The posting must exist before we insert. saved_jobs has a foreign key to
  // job_postings, and ON CONFLICT DO NOTHING does not suppress a foreign-key
  // violation — so a bookmark of a non-existent id used to reject inside the
  // handler and take the whole process down with it.
  const exists = await queryOne('SELECT 1 FROM job_postings WHERE posting_id = ? LIMIT 1', [pid]);
  if (!exists) return fail(res, 'Opening not found.');

  const { affectedRows } = await exec('DELETE FROM saved_jobs WHERE user_id = ? AND posting_id = ?', [u.user_id, pid]);
  if (affectedRows === 0) {
    await exec('INSERT INTO saved_jobs (user_id, posting_id) VALUES (?,?) ON CONFLICT DO NOTHING', [u.user_id, pid]);
    return ok(res, { saved: true });
  }
  ok(res, { saved: false });
});

export default router;
