/* ResumeMatch PH — routes/match.ts : score · recommendations
   The three-tier output. The third tier is the point of the whole
   system: below the threshold you get REDIRECTED, not rejected.   */
import { Router } from 'express';
import { query, queryOne } from '../db';
import { PostingRow } from '../types';
import { ok, fail } from '../lib/http';
import { requireUser, requireRole } from '../lib/auth';
import { fetchResume, fetchPosting, serializeResume, serializePosting } from '../lib/serializers';
import { rmScore, cacheScore } from '../lib/engine';

const router = Router();

router.post('/score', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const r = await fetchResume(Number(req.body?.resumeId));
  const p = await fetchPosting(Number(req.body?.postingId));
  if (!r || !p) return fail(res, 'Not found.');

  if (u.role === 'seeker' && r.user_id !== u.user_id) return fail(res, 'You can only score your own resumes.', 403);

  ok(res, await rmScore(await serializeResume(r), await serializePosting(p, false)));
});

router.post('/recommendations', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;

  let rid = u.active_resume_id;
  if (!rid) {
    const row = await queryOne<{ resume_id: number }>(
      'SELECT resume_id FROM resumes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [u.user_id],
    );
    rid = row ? row.resume_id : null;
  }
  if (!rid) return ok(res, { resume: null, strong: [], possible: [], related: [] });

  const r = await fetchResume(rid);
  if (!r) return ok(res, { resume: null, strong: [], possible: [], related: [] });
  const resume = await serializeResume(r);

  const appliedRows = await query<{ posting_id: number }>('SELECT posting_id FROM applications WHERE seeker_id = ?', [u.user_id]);
  const applied = appliedRows.map((a) => String(a.posting_id));

  const rows = await query<PostingRow>("SELECT * FROM job_postings WHERE status='open'");

  const strong: any[] = [], possible: any[] = [], related: any[] = [];
  for (const p of rows) {
    const posting = await serializePosting(p);
    const s = await rmScore(resume, posting);
    await cacheScore(rid, p.posting_id, s);

    const item = {
      ...s,
      posting,
      company: posting.company ?? null,
      applied: applied.includes(String(p.posting_id)),
    };

    if (s.tier === 'strong') strong.push(item);
    else if (s.tier === 'possible') possible.push(item);
    // A related role must share at least one real skill, or it's noise
    // rather than a suggestion.
    else if (s.matchedSkills.length) related.push(item);
  }

  const bySc = (a: any, b: any) => b.score - a.score;
  strong.sort(bySc); possible.sort(bySc); related.sort(bySc);

  ok(res, { resume, strong, possible, related });
});

export default router;
