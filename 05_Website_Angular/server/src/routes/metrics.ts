/* ResumeMatch PH — routes/metrics.ts
   Researcher-facing aggregates for the study's evaluation chapter.
   Admin only, and everything is anonymous by construction — counts,
   distributions, and durations, never a name or an email. */
import { asyncRouter } from '../lib/async-router';
import { query, queryOne } from '../db';
import { ok } from '../lib/http';
import { requireRole } from '../lib/auth';
import { getSettings } from '../lib/engine';

const router = asyncRouter();

router.post('/summary', async (req, res) => {
  const u = await requireRole(req, res, 'admin');
  if (!u) return;

  const T = (await getSettings()).thresholds;

  // Volumes
  // Aliases that must keep their camelCase are double-quoted, since
  // Postgres folds unquoted identifiers to lowercase.
  const volumes = await queryOne<any>(`SELECT
    (SELECT COUNT(*) FROM users WHERE role='seeker')                       AS seekers,
    (SELECT COUNT(*) FROM users WHERE role='recruiter')                    AS recruiters,
    (SELECT COUNT(*) FROM resumes)                                         AS resumes,
    (SELECT COUNT(*) FROM job_postings)                                    AS postings,
    (SELECT COUNT(*) FROM job_postings WHERE status='open')                AS "openPostings",
    (SELECT COUNT(*) FROM applications)                                    AS applications,
    (SELECT COUNT(*) FROM saved_jobs)                                      AS "savedJobs"`);

  // Distribution of scores AT THE MOMENT OF APPLYING (score_snapshot) —
  // ten buckets, 0-9 … 90-100.
  const snap = await query<{ bucket: number; n: number }>(
    `SELECT CAST(LEAST(FLOOR(score_snapshot / 10), 9) AS INT) AS bucket, COUNT(*) AS n
       FROM applications WHERE score_snapshot IS NOT NULL GROUP BY 1`,
  );
  const scoreBuckets = Array.from({ length: 10 }, (_, i) => ({
    range: i === 9 ? '90–100' : `${i * 10}–${i * 10 + 9}`,
    count: 0,
  }));
  for (const r of snap) scoreBuckets[Number(r.bucket)].count = Number(r.n);

  const avg = await queryOne<{ a: number | null }>(
    'SELECT AVG(score_snapshot) AS a FROM applications WHERE score_snapshot IS NOT NULL');

  // Tier of each application when it was submitted — including how often
  // people applied to "related" (below-threshold) roles anyway, which is
  // the study's no-rejection claim in action.
  const tiers = await queryOne<any>(`SELECT
    COUNT(*) FILTER (WHERE score_snapshot >= ${Number(T.strong)})                                              AS strong,
    COUNT(*) FILTER (WHERE score_snapshot >= ${Number(T.related)} AND score_snapshot < ${Number(T.strong)})    AS possible,
    COUNT(*) FILTER (WHERE score_snapshot < ${Number(T.related)})                                              AS related
    FROM applications WHERE score_snapshot IS NOT NULL`);

  // Status funnel
  const funnelRows = await query<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM applications GROUP BY status');
  const funnel: Record<string, number> = { submitted: 0, review: 0, shortlisted: 0, rejected: 0, hired: 0 };
  for (const r of funnelRows) funnel[r.status] = Number(r.n);

  // Median-ish responsiveness: average hours from application to the
  // FIRST recruiter decision (any move out of 'submitted').
  const firstMove = await queryOne<{ avgHours: number | null; decided: number }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (h.first_change - a.applied_at)) / 3600) AS "avgHours", COUNT(*) AS decided
       FROM applications a
       JOIN (SELECT application_id, MIN(changed_at) AS first_change
               FROM application_status_history WHERE new_status <> 'submitted'
              GROUP BY application_id) h ON h.application_id = a.application_id`,
  );

  ok(res, {
    metrics: {
      generatedAt: new Date().toISOString(),
      thresholds: T,
      volumes: {
        seekers: Number(volumes?.seekers ?? 0),
        recruiters: Number(volumes?.recruiters ?? 0),
        resumes: Number(volumes?.resumes ?? 0),
        postings: Number(volumes?.postings ?? 0),
        openPostings: Number(volumes?.openPostings ?? 0),
        applications: Number(volumes?.applications ?? 0),
        savedJobs: Number(volumes?.savedJobs ?? 0),
      },
      scores: {
        average: volumes?.applications ? Math.round(Number(avg?.a ?? 0) * 10) / 10 : null,
        buckets: scoreBuckets,
      },
      tiersAtApplication: {
        strong: Number(tiers?.strong ?? 0),
        possible: Number(tiers?.possible ?? 0),
        related: Number(tiers?.related ?? 0),
      },
      funnel,
      responsiveness: {
        applicationsDecided: Number(firstMove?.decided ?? 0),
        avgHoursToFirstDecision: firstMove?.avgHours != null ? Math.round(Number(firstMove.avgHours) * 10) / 10 : null,
      },
    },
  });
});

export default router;
