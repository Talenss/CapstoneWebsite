/* Linaw PH — routes/stats.ts : hr (dashboard counters) */
import { asyncRouter } from '../lib/async-router';
import { queryOne, query } from '../db';
import { ok } from '../lib/http';
import { requireRole } from '../lib/auth';

const router = asyncRouter();

/** One day past the end date the recruiter picked.
 *
 *  A date filter is read by the person using it as "up to and including this
 *  day", but applied_at is a timestamp, so comparing against the raw date
 *  drops everything that happened after midnight ON that day — the whole day
 *  they asked for, minus its first instant. Half-open [from, to+1day) counts
 *  it and needs no assumption about the column's precision. */
function endOfDay(iso: string): string | null {
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** A plain YYYY-MM-DD, or null. Anything else is ignored rather than passed
 *  to Postgres, so a malformed value narrows nothing instead of erroring. */
function asDate(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function asId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function asText(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, 120) : null;
}

router.post('/hr', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const cid = u.company_id;

  /* The dashboard's filters. Every one is optional, and every one is applied
     HERE rather than in the browser, because the pipeline is a count over
     rows the page never loads — filtering it client-side would mean shipping
     every application to every recruiter to throw most of them away.

     company_id is NOT one of these. It is the caller's own, it is applied
     unconditionally below, and no filter can widen past it. */
  const fPosting = asId(req.body?.postingId);
  const fStaff = asId(req.body?.staffId);
  const fDept = asText(req.body?.department);
  const fWho = asText(req.body?.applicant);
  const fFrom = asDate(req.body?.from);
  const fTo = asDate(req.body?.to);

  /* Built in step: a clause and its parameter are pushed together, so the
     two lists cannot drift out of order however many filters are set. */
  const where: string[] = [];
  const args: unknown[] = [];

  if (fPosting) { where.push('jp.posting_id = ?'); args.push(fPosting); }
  if (fDept) { where.push('jp.department = ?'); args.push(fDept); }

  /* "Whose pipeline is this" follows the DEPARTMENT ROUTING, not who typed
     the posting in. Routing is what decides who is responsible for an
     application — it is the rule that mails them when one arrives — so a
     colleague filtering to themselves should see what lands on their desk,
     not only the vacancies they happened to create. */
  if (fStaff) {
    where.push(`EXISTS (SELECT 1 FROM department_assignments da
                         WHERE da.company_id = jp.company_id
                           AND da.department = jp.department
                           AND da.user_id = ?)`);
    args.push(fStaff);
  }

  if (fWho) {
    where.push(`EXISTS (SELECT 1 FROM users su
                         WHERE su.user_id = a.seeker_id
                           AND (su.full_name ILIKE ? OR su.email ILIKE ?))`);
    args.push('%' + fWho + '%', '%' + fWho + '%');
  }

  if (fFrom) { where.push('a.applied_at >= ?'); args.push(fFrom); }
  if (fTo) {
    const end = endOfDay(fTo);
    if (end) { where.push('a.applied_at < ?'); args.push(end); }
  }

  const extra = where.length ? ' AND ' + where.join(' AND ') : '';

  /* The opening counters describe the OPENINGS, so only the filters that are
     about an opening narrow them. An applicant name or an applied-on range
     says nothing about how many vacancies are posted, and letting either
     change these two numbers would make "3 open" mean something different
     depending on whose name was typed above it. */
  const postWhere: string[] = [];
  const postArgs: unknown[] = [];
  if (fPosting) { postWhere.push('posting_id = ?'); postArgs.push(fPosting); }
  if (fDept) { postWhere.push('department = ?'); postArgs.push(fDept); }
  if (fStaff) {
    postWhere.push(`EXISTS (SELECT 1 FROM department_assignments da
                             WHERE da.company_id = job_postings.company_id
                               AND da.department = job_postings.department
                               AND da.user_id = ?)`);
    postArgs.push(fStaff);
  }

  const p = await queryOne<{ total: number; open_n: number }>(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='open') AS open_n
       FROM job_postings
      WHERE company_id = ?${postWhere.length ? ' AND ' + postWhere.join(' AND ') : ''}`,
    [cid, ...postArgs],
  );

  const rows = await query<{ status: string; n: number }>(
    `SELECT a.status, COUNT(*) AS n
       FROM applications a
       JOIN job_postings jp ON jp.posting_id = a.posting_id
      WHERE jp.company_id = ?${extra}
      GROUP BY a.status`, [cid, ...args],
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

  /* The same counts split by opening, under the same filters, so each stage
     on the dashboard can lead to the openings its number is made of. Only
     non-zero cells are sent: an opening absent from a stage has nobody there. */
  const cells = await query<{ posting_id: number; status: string; n: number }>(
    `SELECT a.posting_id, a.status, COUNT(*) AS n
       FROM applications a
       JOIN job_postings jp ON jp.posting_id = a.posting_id
      WHERE jp.company_id = ?${extra}
      GROUP BY a.posting_id, a.status`, [cid, ...args],
  );
  const byPosting: Record<string, Record<string, number>> = {};
  for (const c of cells) {
    const k = String(c.posting_id);
    (byPosting[k] ??= {})[c.status] = Number(c.n);
  }

  ok(res, {
    stats: {
      openPostings: Number(p?.open_n ?? 0),
      totalPostings: Number(p?.total ?? 0),
      totalApplicants: total,
      needsReview: byStatus.submitted,
      byStatus,
      byPosting,
    },
  });
});

/** The company's own recruiters, for the "whose pipeline" picker.
 *
 *  Scoped to the caller's company and to recruiters, and it returns a name
 *  and an id and nothing else — this is a dropdown, not a directory, and an
 *  email address or a position is not needed to populate one. */
router.post('/hr-staff', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const rows = await query<{ user_id: number; full_name: string }>(
    `SELECT user_id, full_name FROM users
      WHERE company_id = ? AND role = 'recruiter'
      ORDER BY full_name`, [u.company_id],
  );
  ok(res, { staff: rows.map((r) => ({ id: String(r.user_id), name: r.full_name })) });
});

export default router;
