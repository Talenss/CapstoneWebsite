/* ResumeMatch PH — routes/stats.ts : hr (dashboard counters) */
import { asyncRouter } from '../lib/async-router';
import { queryOne, query } from '../db';
import { ok } from '../lib/http';
import { requireRole } from '../lib/auth';

const router = asyncRouter();

router.post('/hr', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const cid = u.company_id;

  const p = await queryOne<{ total: number; open_n: number }>(
    "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='open') AS open_n FROM job_postings WHERE company_id = ?", [cid],
  );

  const rows = await query<{ status: string; n: number }>(
    `SELECT a.status, COUNT(*) AS n
       FROM applications a
       JOIN job_postings jp ON jp.posting_id = a.posting_id
      WHERE jp.company_id = ?
      GROUP BY a.status`, [cid],
  );

  const byStatus: Record<string, number> = { submitted: 0, review: 0, shortlisted: 0, rejected: 0, hired: 0 };
  let total = 0;
  for (const r of rows) { byStatus[r.status] = Number(r.n); total += Number(r.n); }

  ok(res, {
    stats: {
      openPostings: Number(p?.open_n ?? 0),
      totalPostings: Number(p?.total ?? 0),
      totalApplicants: total,
      needsReview: byStatus.submitted,
      byStatus,
    },
  });
});

export default router;
