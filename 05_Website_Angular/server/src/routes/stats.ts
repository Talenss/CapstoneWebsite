/* Linaw PH — routes/stats.ts : hr (dashboard counters) */
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

  // Every status seeded to zero — the partner's eight-stage pipeline, plus
  // 'rejected', 'withdrawn' and the legacy 'review'. The recruiter dashboard
  // renders one pipeline tile per stage in STATUS_ORDER, so a stage missing
  // from this object shows a blank tile rather than a 0; keeping the full set
  // here means a newly added stage is counted, not dropped. Kept in step with
  // the client's STATUS_LABELS.
  const byStatus: Record<string, number> = {
    submitted: 0, scheduling: 0, initial_interview: 0, testing: 0, shortlisted: 0,
    final_interview: 0, offer: 0, hired: 0, rejected: 0, withdrawn: 0, review: 0,
  };
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
