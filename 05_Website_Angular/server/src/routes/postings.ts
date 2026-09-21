/* Linaw PH — routes/postings.ts : list · mine · get · save · toggle */
import { asyncRouter } from '../lib/async-router';
import { query, queryOne, exec, withTransaction } from '../db';
import { PostingRow, UserRow, ResumeRow } from '../types';
import { ok, fail, idOf } from '../lib/http';
import { requireRole, currentUser } from '../lib/auth';
import { fetchPosting, fetchResume, serializePosting, serializeResume, visibleResume } from '../lib/serializers';
import { EDU_RANK, skillId, rmScore, getSettings, certNorm, OPTIONAL_WEIGHTS, WEIGHT_FLOOR } from '../lib/engine';
import { notifyNewPostingMatch } from '../lib/notify';

const router = asyncRouter();

// Public: every open position still accepting applications (a past
// application deadline hides a posting without anyone closing it).
router.post('/list', async (_req, res) => {
  const rows = await query<PostingRow>(
    `SELECT * FROM job_postings
      WHERE status='open' AND (application_deadline IS NULL OR application_deadline >= CURRENT_DATE)
      -- posting_id breaks the tie. Two openings posted in the same second is
      -- not hypothetical — the seed does exactly that if its dates are ever
      -- flattened again — and an ORDER BY with ties is free to return a
      -- different order on each request, so a list a recruiter is reading
      -- reshuffles under them for no reason they can see.
      ORDER BY created_at DESC, posting_id DESC`,
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
  // Score everyone first, then send. Scoring and mailing used to be
  // interleaved in one serial loop, so a single slow SMTP handshake stalled
  // every seeker behind it — with 500 seekers that is 500 sequential
  // round trips before the last person is considered at all.
  const recipients: { email: string; name: string; score: number; tier: string }[] = [];
  for (const s of seekers) {
    try {
      const r = await fetchResume(s.active_resume_id!);
      if (!r) continue;
      const score = await rmScore(visibleResume(await serializeResume(r as ResumeRow)), posting);
      if (score.score < T.related) continue; // below "possible" — no alert
      recipients.push({ email: s.email, name: s.full_name, score: score.score, tier: score.tier });
    } catch (e: any) {
      console.error('job alert scoring failed for', s.email, '-', e?.message || e);
    }
  }

  // Send in small batches: fast enough that a posting's alerts go out
  // promptly, bounded enough that we never open hundreds of SMTP
  // connections at once. One failure never stops the others.
  const BATCH = 5;
  for (let i = 0; i < recipients.length; i += BATCH) {
    await Promise.allSettled(
      recipients.slice(i, i + BATCH).map((rc) =>
        notifyNewPostingMatch(rc.email, rc.name, p.title, companyName, rc.score, rc.tier as any)
          .catch((e: any) => console.error('job alert failed for', rc.email, '-', e?.message || e))),
    );
  }
}

// Recruiter: every posting of MY company, open or closed, with counts.
router.post('/mine', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  /* The colleague this opening's applications route to, joined here so the
     dashboard can filter by them. It comes from the DEPARTMENT ASSIGNMENT
     rather than from created_by: routing is what decides whose desk a new
     application lands on, and that is the question a recruiter narrowing to
     a name is asking. A department nobody owns joins to null, which reads as
     "unassigned" and is a real answer rather than a gap. */
  const rows = await query<PostingRow & { owner_id: number | null; owner_name: string | null }>(
    `SELECT jp.*, du.user_id AS owner_id, du.full_name AS owner_name
       FROM job_postings jp
       LEFT JOIN department_assignments da
              ON da.company_id = jp.company_id AND da.department = jp.department
       LEFT JOIN users du ON du.user_id = da.user_id
      WHERE jp.company_id = ?
      ORDER BY jp.created_at DESC, jp.posting_id DESC`, [u.company_id],
  );

  const out = [];
  for (const p of rows) {
    const row = await serializePosting(p);
    const n = await queryOne<{ total: number; fresh: number }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'submitted') AS fresh FROM applications WHERE posting_id = ?`, [p.posting_id],
    );
    row.applicantCount = Number(n?.total ?? 0);
    row.newCount = Number(n?.fresh ?? 0);
    row.ownerId = p.owner_id == null ? null : String(p.owner_id);
    row.ownerName = p.owner_name ?? null;
    out.push(row);
  }
  ok(res, { postings: out });
});

router.post('/get', async (req, res) => {
  const p = await fetchPosting(idOf(req.body?.id));
  if (!p) return fail(res, 'That opening no longer exists.');

  // Public, so it must show only what /list already shows. Without this an
  // anonymous caller could walk posting ids and read every company's CLOSED
  // and expired openings, department and all. Recruiters reach their own
  // company's closed postings through /mine, which is role-scoped.
  const expired = p.application_deadline
    && new Date(p.application_deadline) < new Date(new Date().toDateString());
  if (p.status !== 'open' || expired) {
    const u = await currentUser(req);
    const mine = u?.role === 'recruiter' && u.company_id === p.company_id;
    if (!mine && u?.role !== 'admin')
      return fail(res, 'That opening is no longer accepting applications.');
  }

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
  /* Certifications the opening asks for. Deduplicated on the NORMALISED form,
     because "CCNA" and "C.C.N.A." are the same requirement and listing both
     would make the component impossible to score out of. */
  const freeTextList = (input: unknown, maxLen: number, cap: number): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const c of Array.isArray(input) ? input : []) {
      const name = String(c).trim().slice(0, maxLen);
      const norm = certNorm(name);
      if (!name || !norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(name);
      if (out.length >= cap) break;
    }
    return out;
  };
  const certifications = freeTextList(P.certifications, 160, 20);
  /* Languages are the same shape as certifications and normalised by the same
     function, because both are free text an opening either names or does not,
     with no catalogue to intern them into the way skills have. */
  const languages = freeTextList(P.languages, 80, 20);

  /* Minimum counts for the two sections scored the way experience is. Zero
     means the opening states no requirement, which scores full marks. */
  const minProjects = Math.max(0, Math.min(50, Math.trunc(Number(P.minProjects) || 0)));
  const minReferences = Math.max(0, Math.min(50, Math.trunc(Number(P.minReferences) || 0)));

  /* Screening questions. Capped in count and length because they are shown to
     every applicant before they can apply: an unbounded list is a wall, and an
     unbounded prompt is somewhere to paste a whole job description.

     Folded case-insensitively, the way required skills and certificates are.
     The same question asked twice is one question, and asking an applicant to
     type the answer again is a bug however it got there. */
  const questions: string[] = [];
  {
    const seen = new Set<string>();
    for (const q of Array.isArray(P.questions) ? P.questions : []) {
      const prompt = String(typeof q === 'string' ? q : (q?.prompt ?? '')).trim().slice(0, 300);
      const key = prompt.toLowerCase();
      if (!prompt || seen.has(key)) continue;
      seen.add(key);
      questions.push(prompt);
      if (questions.length >= 10) break;
    }
  }

  if (title.length < 2) return fail(res, 'Give the opening a title.');
  if (dept === '') return fail(res, 'Which department is this for?');
  if (desc.length < 10) return fail(res, 'Describe the role in a sentence or two.');
  if (!skills.length) return fail(res, "Add at least one required skill. There is nothing to match an applicant against without one.");

  const edu = Object.keys(EDU_RANK).includes(P.educationLevel) ? P.educationLevel : 'bachelor';
  const type = ['full-time', 'part-time', 'contract', 'internship'].includes(P.employmentType) ? P.employmentType : 'full-time';
  const months = Math.max(0, Number(P.minExperienceMonths) || 0);

  /* Optional per-opening weights, sent as whole percentages. Absent means the
     opening inherits the site defaults, which is what every existing posting
     does — so this validates only what was actually supplied.

     The floor is policy, not arithmetic: a recruiter may decide education
     matters less for a role, but may not switch a criterion off, because an
     applicant whose only strength is the zeroed one would be scored on a
     scale that cannot see them at all. The same rule is a CHECK constraint on
     the table, so a bad set cannot arrive by any other route either. */
  let weights: Record<string, number> | null = null;
  if (P.weights != null) {
    const W = P.weights;
    const pct = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && Number.isInteger(n) ? n : null;
    };
    const sk = pct(W.skills), ed = pct(W.education), ex = pct(W.experience);
    if (sk === null || ed === null || ex === null)
      return fail(res, 'The scoring weights must be whole numbers.');
    if (sk < WEIGHT_FLOOR || ed < WEIGHT_FLOOR || ex < WEIGHT_FLOOR)
      return fail(res, `Skills, education and experience each have to be at least ${WEIGHT_FLOOR}%. Those three cannot be switched off entirely.`);
    /* The optional components are the ones a recruiter may switch off, and off
       is the default for every one of them. Absent means 0, which is what
       keeps an opening written before a component existed valid without
       being rewritten. */
    const opt: Record<string, number> = {};
    for (const k of OPTIONAL_WEIGHTS) {
      const raw = (W as Record<string, unknown>)[k];
      const v = raw === undefined || raw === null ? 0 : pct(raw);
      if (v === null) return fail(res, 'The scoring weights must be whole numbers.');
      if (v < 0) return fail(res, `The ${k} weight cannot be negative.`);
      opt[k] = v;
    }
    const total = sk + ed + ex + OPTIONAL_WEIGHTS.reduce((s: number, k) => s + opt[k], 0);
    if (total !== 100)
      return fail(res, `The weights have to add up to 100%. They currently add up to ${total}%.`);
    weights = { skills: sk, education: ed, experience: ex, ...opt };
  }

  // Optional "apply by" date. Must be today or later when set.
  let deadline: string | null = null;
  if (P.deadline) {
    const d = String(P.deadline).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return fail(res, 'The application deadline looks wrong. Use the date picker.');
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

      // All of them or all null — never a mix, which the CHECK rejects.
      const w = (k: string) => (weights ? weights[k] : null);
      const wS = w('skills'), wE = w('education'), wX = w('experience');
      const wC = w('certifications'), wP = w('projects'), wL = w('languages'), wR = w('references');
      const wV = w('relevance');

      if (pid) {
        await tx.exec(
          `UPDATE job_postings SET title=?, department=?, employment_type=?, description=?, education_level=?,
             min_experience_months=?, min_projects=?, min_references=?, application_deadline=?,
             weight_skills=?, weight_education=?, weight_experience=?,
             weight_certifications=?, weight_projects=?, weight_languages=?, weight_references=?, weight_relevance=?
           WHERE posting_id=?`,
          [title, dept, type, desc, edu, months, minProjects, minReferences, deadline,
            wS, wE, wX, wC, wP, wL, wR, wV, pid],
        );
      } else {
        const ins = await tx.exec(
          `INSERT INTO job_postings (company_id, created_by, title, department, employment_type, description,
             education_level, min_experience_months, min_projects, min_references, application_deadline,
             weight_skills, weight_education, weight_experience,
             weight_certifications, weight_projects, weight_languages, weight_references, weight_relevance, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open') RETURNING posting_id`,
          [u.company_id, u.user_id, title, dept, type, desc, edu, months, minProjects, minReferences, deadline,
            wS, wE, wX, wC, wP, wL, wR, wV],
        );
        pid = ins.insertId;
      }

      /* Required certifications. Free text, so there is no catalogue to
         intern them into the way skills are — the normalised form is stored
         beside the name because it is what the engine compares, and it is the
         primary key, so the same certificate cannot be listed twice. */
      await tx.exec('DELETE FROM posting_certifications WHERE posting_id = ?', [pid]);
      for (const c of certifications) {
        await tx.exec(
          'INSERT INTO posting_certifications (posting_id, cert_name, cert_norm) VALUES (?,?,?) ON CONFLICT DO NOTHING',
          [pid, c, certNorm(c)],
        );
      }

      // Required languages, stored and compared exactly as certifications are.
      await tx.exec('DELETE FROM posting_languages WHERE posting_id = ?', [pid]);
      for (const l of languages) {
        await tx.exec(
          'INSERT INTO posting_languages (posting_id, lang_name, lang_norm) VALUES (?,?,?) ON CONFLICT DO NOTHING',
          [pid, l, certNorm(l)],
        );
      }

      /* SCREENING QUESTIONS ARE MATCHED BY THEIR WORDING, never replaced
         wholesale.

         An answer belongs to the wording it was given under, so a question
         whose text the recruiter CHANGED is a different question and its
         answers go with it — application_answers cascades from question_id.
         That much was always intended. What must not happen, and did while
         this deleted every row and reinserted it, is that an ordinary edit
         destroys answers to questions nobody touched: fixing a typo in the
         description, moving the deadline, closing the opening or dragging one
         question up the list wiped every answer every applicant had given.
         A recruiter cannot be expected to know that editing a job advert
         throws away the replies they collected.

         So the rows that still carry the same wording are kept and only
         renumbered; the ones whose wording is genuinely gone are deleted, and
         take their own answers with them and nobody else's. */
      const existingQs = await tx.query<{ question_id: number; prompt: string }>(
        'SELECT question_id, prompt FROM posting_questions WHERE posting_id = ? ORDER BY sort_order, question_id',
        [pid],
      );
      /* Keyed the same way the payload was folded, so a question re-sent with
         different capitalisation is recognised as the one already stored
         rather than treated as a new one — which would drop its answers. */
      const keepById = new Map<string, number>();
      for (const row of existingQs) {
        const key = row.prompt.trim().toLowerCase();
        if (!keepById.has(key)) keepById.set(key, Number(row.question_id));
      }
      const wanted = new Set(questions.map((q) => q.toLowerCase()));

      for (const row of existingQs) {
        const key = row.prompt.trim().toLowerCase();
        // Gone from the list, or a duplicate row left by an older save that
        // did not fold them — either way this row is not the one being kept.
        if (!wanted.has(key) || keepById.get(key) !== Number(row.question_id)) {
          await tx.exec('DELETE FROM posting_questions WHERE question_id = ?', [row.question_id]);
        }
      }
      for (let i = 0; i < questions.length; i++) {
        const id = keepById.get(questions[i].toLowerCase());
        if (id !== undefined) {
          // Same question, possibly moved and possibly recapitalised. Update
          // rather than delete, so every answer already given to it survives.
          await tx.exec(
            'UPDATE posting_questions SET prompt = ?, sort_order = ? WHERE question_id = ?',
            [questions[i], i, id],
          );
        } else {
          await tx.exec(
            'INSERT INTO posting_questions (posting_id, prompt, sort_order) VALUES (?,?,?)',
            [pid, questions[i], i],
          );
        }
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
  const id = idOf(req.body?.id);
  const p = await fetchPosting(id);
  if (!p || p.company_id !== u.company_id) return fail(res, 'Opening not found.');

  const next = p.status === 'open' ? 'closed' : 'open';
  await exec('UPDATE job_postings SET status = ? WHERE posting_id = ?', [next, id]);
  ok(res, { posting: await serializePosting((await fetchPosting(id))!) });
});

export default router;
