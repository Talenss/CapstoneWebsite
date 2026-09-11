/* Linaw PH — routes/applications.ts : apply · mine · ranked · set-status */
import { asyncRouter } from '../lib/async-router';
import { query, queryOne, exec, withTransaction } from '../db';
import { ApplicationRow, ResumeRow } from '../types';
import { ok, fail, idOf } from '../lib/http';
import { requireRole, requireUser } from '../lib/auth';
import { fetchResume, fetchPosting, postingExpired, prefetchResumeChildren, serializeResume, serializePosting, serializeApplication, visibleResume, ts } from '../lib/serializers';
import { rmScore, rmFileScore, cacheScore, getSettings, REJECTION_REASONS } from '../lib/engine';
import { notifyStatusChange, notifyNewApplication, sendInterviewInvite } from '../lib/notify';
import { UserRow } from '../types';

const router = asyncRouter();

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
  const rid = idOf(req.body?.resumeId);
  const pid = idOf(req.body?.postingId);

  const r = await fetchResume(rid);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Choose one of your own resumes.');

  const p = await fetchPosting(pid);
  if (!p) return fail(res, 'That opening no longer exists.');
  if (p.status !== 'open') return fail(res, 'This opening is closed.');
  if (postingExpired(p)) return fail(res, 'The application deadline for this opening has passed.');

  const dup = await queryOne('SELECT 1 FROM applications WHERE seeker_id=? AND posting_id=? LIMIT 1', [u.user_id, pid]);
  if (dup) return fail(res, 'You already applied to this position.');

  /* THE RECRUITER'S OWN SCREENING QUESTIONS.
     Every question on the opening must be answered before the application is
     accepted -- that is what makes them mandatory, and checking it here is
     what makes it true rather than a courtesy the apply screen extends. The
     questions are read from the database, never from the payload: a client
     that sent an answer for a question the recruiter had deleted, or omitted
     one it did not feel like showing, would otherwise decide for itself what
     this opening requires.

     Nothing here is scored. The answers are free text a person reads, and
     the engine never sees them. */
  const questions = await query<{ question_id: number; prompt: string }>(
    'SELECT question_id, prompt FROM posting_questions WHERE posting_id=? ORDER BY sort_order, question_id', [pid],
  );
  const sent = new Map<number, string>();
  const rawAnswers = Array.isArray(req.body?.answers) ? req.body.answers.slice(0, 50) : [];
  for (const a of rawAnswers) {
    const qid = Number(a?.questionId);
    if (Number.isFinite(qid)) sent.set(qid, String(a?.answer ?? '').trim().slice(0, 2000));
  }
  const answers: { questionId: number; answer: string }[] = [];
  for (const q of questions) {
    const text = sent.get(Number(q.question_id)) ?? '';
    if (!text) {
      // Named, not counted. "1 unanswered" leaves the applicant hunting for
      // which one, and the apply screen may have scrolled past it.
      return fail(res, `Please answer the question: "${q.prompt}"`);
    }
    answers.push({ questionId: Number(q.question_id), answer: text });
  }

  /* Record the score AS IT WAS at the moment of applying -- on the resume as
     the recruiter will see it. visibleResume drops the sections the applicant
     switched off, so a hidden section cannot earn marks toward a number that
     is meant to describe the sheet arriving on the recruiter's screen. */
  const s = await rmScore(visibleResume(await serializeResume(r)), await serializePosting(p, false));

  // One unit of work. The schema's promise — that every status a row has
  // ever held is attributable to a named human — cannot survive an
  // application row existing without its opening history entry.
  let insertId: number;
  try {
    insertId = await withTransaction(async (tx) => {
      const ins = await tx.exec(
        "INSERT INTO applications (seeker_id, resume_id, posting_id, status, score_snapshot) VALUES (?,?,?,'submitted',?) RETURNING application_id",
        [u.user_id, rid, pid, s.score],
      );
      await tx.exec(
        "INSERT INTO application_status_history (application_id, old_status, new_status, changed_by) VALUES (?,NULL,'submitted',?)",
        [ins.insertId, u.user_id],
      );
      // Inside the same transaction as the application row: an application
      // that exists without the answers it was required to carry would be one
      // the recruiter cannot act on and the applicant cannot resubmit.
      for (const a of answers) {
        await tx.exec(
          'INSERT INTO application_answers (application_id, question_id, answer_text) VALUES (?,?,?)',
          [ins.insertId, a.questionId, a.answer],
        );
      }
      return ins.insertId;
    });
  } catch (e: any) {
    // The UNIQUE (seeker_id, posting_id) constraint is the real guard against
    // two simultaneous applies; the check above only catches the common case.
    if (String(e?.code) === '23505') return fail(res, 'You already applied to this position.');
    throw e;
  }
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
  const pid = idOf(req.body?.postingId);
  const p = await fetchPosting(pid);
  if (!p || p.company_id !== u.company_id) return fail(res, 'Opening not found.');

  const posting = await serializePosting(p);
  const T = (await getSettings()).thresholds;   // once, not once per applicant

  const rows = await query<any>(
    `SELECT a.*, u.user_id AS s_id, u.full_name AS s_name, u.email AS s_email
       FROM applications a
       JOIN users u ON u.user_id = a.seeker_id
      WHERE a.posting_id = ?`, [pid],
  );

  /* One set of child-row queries for the whole list rather than seven per
     applicant. Measured on a posting with 302 applications: 1.6 s before,
     because every applicant meant a fresh round trip for their education,
     experience, skills, certificates, projects, languages and references. */
  const resumeRows = await query<ResumeRow>(
    'SELECT * FROM resumes WHERE resume_id = ANY(?)', [[...new Set(rows.map((a) => a.resume_id))]]);
  const byId = new Map(resumeRows.map((r) => [r.resume_id, r]));
  const children = await prefetchResumeChildren(resumeRows.map((r) => r.resume_id));

  /* THE SCREENING ANSWERS, in one query for the whole list rather than one
     per applicant -- the same reason prefetchResumeChildren exists. Joined
     through posting_questions so each answer arrives beside the question it
     answers: a recruiter reading "3 years" needs to see what was asked. The
     question's own order is preserved, so every applicant's answers appear in
     the order the recruiter wrote them. */
  const answerRows = await query<{ application_id: number; question_id: number; prompt: string; answer_text: string }>(
    `SELECT aa.application_id, pq.question_id, pq.prompt, aa.answer_text
       FROM application_answers aa
       JOIN posting_questions pq ON pq.question_id = aa.question_id
      WHERE aa.application_id = ANY(?)
      ORDER BY aa.application_id, pq.sort_order, pq.question_id`,
    [rows.map((a) => a.application_id)],
  );
  /* The field is `prompt`, not `question`, because that is what the shared
     ApplicationAnswer model declares, what demo mode emits and what the
     recruiter's template renders. Emitting a different name here meant the
     answers appeared on screen with no question above them — the reader could
     see "Around 55 words a minute" without being told what was asked. */
  const answersByApp = new Map<number, { questionId: string; prompt: string; answer: string }[]>();
  for (const row of answerRows) {
    const k = Number(row.application_id);
    const list = answersByApp.get(k) ?? [];
    list.push({ questionId: String(row.question_id), prompt: row.prompt, answer: row.answer_text });
    answersByApp.set(k, list);
  }

  const out: any[] = [];
  for (const a of rows) {
    const r = byId.get(a.resume_id) ?? null;

    // An applicant whose resume row has gone must still appear. Skipping the
    // iteration used to drop them from the list silently, which contradicts
    // the promise above that everyone who applied is returned — the recruiter
    // would never know an application had been received at all. Show the row
    // with the score recorded when they applied, and say the resume is gone.
    if (!r) {
      out.push({
        score: a.score_snapshot ?? 0,
        matchedSkills: [], missingSkills: [], totalSkills: 0,
        eduMeets: false, expMeets: false, seekerMonths: 0,
        tier: 'related',
        application: serializeApplication(a),
        resume: null,
        resumeUnavailable: true,
        seeker: { id: String(a.s_id), name: a.s_name, email: a.s_email, role: 'seeker' },
        ...(answersByApp.has(Number(a.application_id)) ? { answers: answersByApp.get(Number(a.application_id)) } : {}),
      });
      continue;
    }

    // Everything the applicant switched off is removed here, once, so it
    // reaches neither the score below nor the recruiter's screen.
    const resume = visibleResume(await serializeResume(r, children));
    const s = await rmScore(resume, posting);
    await cacheScore(a.resume_id, pid, s);

    /* The recruiter sees both numbers. Ranking stays on `score` — the resume
       the applicant typed and can correct — so a parser misreading a scan
       cannot move anybody down the list. `fileScore` sits beside it as
       information about the document, not as a verdict on the person. */
    const fs = await rmFileScore(resume.ownFile?.extract, posting);

    /* RANK ON THE SCORE RECORDED AT APPLICATION, NOT THE LIVE ONE.
     *
     * This list used to sort on the score recomputed on each load, which meant
     * an applicant editing their resume after applying silently reordered a
     * recruiter's shortlist — the list seen on Monday could not be reproduced
     * on Wednesday, and nothing on screen said why. A shortlist a recruiter
     * cannot reproduce is not a record of a decision, and the manuscript's
     * claim that the stored score makes an application reproducible was not
     * true of the screen anybody actually looked at.
     *
     * It also removed the cost of overstating a skill: read the missing ones
     * off the posting, add them afterwards, move up. Ranking on the snapshot
     * means a later edit changes the applicant's NEXT application, not this
     * one. The live score is still returned, so the recruiter can see that the
     * resume moved and by how much — shown as a labelled change rather than an
     * invisible reordering.
     *
     * Applications recorded before this column was populated have no snapshot;
     * they fall back to the live score, which is the old behaviour and the best
     * available answer for a row that never stored one. */
    const ranked = a.score_snapshot ?? s.score;

    /* The tier has to be derived from the number being shown. Spreading the
       live result and overwriting only `score` would leave a 63 labelled
       "strong" whenever the resume had improved since applying — a mismatch
       the recruiter would read as a bug in the scoring, and rightly. */
    const rankedTier = ranked >= T.strong ? 'strong' : ranked >= T.related ? 'possible' : 'related';

    /* REQUIRED SKILLS CLAIMED ON THE DAY OF THE APPLICATION.
     *
     * Reported, never acted on: it does not change the score, the tier or the
     * order, and it never hides anybody. A required skill added the same day
     * someone applied has an innocent explanation as often as not — people
     * update a resume when they see a job they want. What it is worth is a
     * question at interview, and a recruiter is qualified to weigh the answer
     * where the software is not. Deciding for them here would break the
     * study's central claim that the system decides nothing. */
    const addedAt: Record<string, number> = (resume as any).skillsAddedAt ?? {};
    const appliedOn = new Date(ts(a.applied_at)).toISOString().slice(0, 10);
    const sameDayRequired = s.matchedSkills.filter((name) => {
      const at = addedAt[name];
      return at != null && new Date(at).toISOString().slice(0, 10) === appliedOn;
    });

    out.push({
      ...s,
      score: ranked,
      tier: rankedTier,
      liveScore: s.score,
      liveTier: s.tier,
      scoreDrifted: a.score_snapshot != null && a.score_snapshot !== s.score,
      ...(sameDayRequired.length ? { skillsClaimedOnApplyDay: sameDayRequired } : {}),
      application: serializeApplication(a),
      resume,
      seeker: { id: String(a.s_id), name: a.s_name, email: a.s_email, role: 'seeker' },
      ...(fs ? { fileScore: fs } : {}),
      ...(answersByApp.has(Number(a.application_id)) ? { answers: answersByApp.get(Number(a.application_id)) } : {}),
    });
  }

  out.sort((x, y) => y.score - x.score || x.application.appliedAt - y.application.appliedAt);

  /* FILTERING AND PAGING, both server-side and in that order.
   *
   * The filters have to run HERE rather than in the browser now that the list
   * is paged. Filtering a single page would mean "strong only" hid strong
   * applicants who happened to sit on page two — a filter that silently lies
   * about the pool is worse than no filter at all.
   *
   * `total` is everyone who applied and is reported whatever the filters say,
   * because the page promises that everyone who applied is on this list. The
   * pager narrows what is DRAWN; it never narrows what is counted.
   *
   * pageSize 0 means "all matching rows", which is what Export CSV and Print
   * ask for: what leaves the screen must be the whole filtered set, not
   * whichever page the recruiter happens to be looking at. */
  const total = out.length;
  const q = String(req.body?.q ?? '').trim().toLowerCase();
  const fStatus = String(req.body?.status ?? '');
  const fTier = String(req.body?.tier ?? '');
  const fFile = String(req.body?.file ?? '');

  const matchedRows = out.filter((r: any) => {
    if (fStatus && r.application.status !== fStatus) return false;
    if (fTier && r.tier !== fTier) return false;
    if (fFile === 'yes' && !r.resume?.ownFile) return false;
    if (fFile === 'no' && r.resume?.ownFile) return false;
    if (!q) return true;
    return (r.seeker.name + ' ' + (r.resume?.skills || []).join(' ')).toLowerCase().includes(q);
  });

  /* Absent pageSize means "everything", which is what this route has always
     returned. Paging is something the caller ASKS for: defaulting to a page
     would silently truncate every existing caller, and the ranking has to
     score the whole pool anyway to know what belongs on page one — the saving
     is payload and DOM, not work. 200 is the ceiling so a hand-written request
     cannot ask for an unbounded page and call it paging. */
  const rawSize = Number(req.body?.pageSize);
  const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(rawSize, 200) : 0;
  const pages = pageSize ? Math.max(1, Math.ceil(matchedRows.length / pageSize)) : 1;
  const page = Math.min(Math.max(1, Number(req.body?.page) || 1), pages);
  const slice = pageSize ? matchedRows.slice((page - 1) * pageSize, page * pageSize) : matchedRows;

  ok(res, { posting, rows: slice, total, matched: matchedRows.length, page, pages, pageSize });
});

/* Every status change is a HUMAN decision, and it is recorded as one. */
router.post('/set-status', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const aid = idOf(req.body?.id);
  const status = String(req.body?.status ?? '');

  // The recruiter-settable pipeline (partner's eight stages + the rejected
   // off-ramp). Kept in step with STATUS_ORDER on the client. 'review' is a
   // legacy value that is no longer settable; 'withdrawn' is the applicant's.
  if (!['submitted', 'scheduling', 'initial_interview', 'testing', 'shortlisted',
        'final_interview', 'offer', 'hired', 'rejected'].includes(status))
    return fail(res, 'Unknown status.');

  /* WHY, when the recruiter gave one.
   *
   * Optional on purpose. Requiring it would have made every existing caller
   * invalid overnight, and — more to the point — a recruiter who is made to
   * pick something in order to proceed picks the first item on the list, which
   * produces a column full of confident nonsense. The applicant view asks for
   * one on a rejection and the recruiter can still decline; a blank here means
   * nobody stated a reason, which is honest, where a defaulted code would not
   * be. */
  const rawReason = req.body?.reason == null ? null : String(req.body.reason);
  if (rawReason !== null && !REJECTION_REASONS.includes(rawReason as any))
    return fail(res, 'Unknown reason.');
  const reason = rawReason || null;

  const a = await queryOne<ApplicationRow & { company_id: number }>(
    `SELECT a.*, p.company_id
       FROM applications a
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE a.application_id = ?`, [aid],
  );
  if (!a || a.company_id !== u.company_id) return fail(res, 'Application not found.');
  // A withdrawn application is the applicant's decision, not the recruiter's
  // to reverse. It stays visible in the list, but its status is frozen.
  if (a.status === 'withdrawn') return fail(res, 'This applicant withdrew their application.');

  // Atomic for the same reason as apply: a status change that leaves no
  // history row would be a decision with nobody's name on it.
  await withTransaction(async (tx) => {
    await tx.exec('UPDATE applications SET status = ? WHERE application_id = ?', [status, aid]);
    await tx.exec(
      'INSERT INTO application_status_history (application_id, old_status, new_status, changed_by, reason) VALUES (?,?,?,?,?)',
      [aid, a.status, status, u.user_id, reason],
    );
  });

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

/* The applicant's own exit. The privacy notice promises consent can be
   withdrawn; before this, the only mechanism was deleting the whole
   account. Withdrawing marks the application (rather than deleting it)
   so the recruiter sees an honest "Withdrawn" instead of a row that
   silently vanishes mid-process — and the audit trail stays intact. */
router.post('/withdraw', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const aid = idOf(req.body?.id);

  const a = await queryOne<ApplicationRow>('SELECT * FROM applications WHERE application_id = ?', [aid]);
  if (!a || a.seeker_id !== u.user_id) return fail(res, 'You can only withdraw your own applications.');
  if (a.status === 'withdrawn') return fail(res, 'This application is already withdrawn.');
  // Once a person has decided, there is nothing left to withdraw from.
  if (a.status === 'hired' || a.status === 'rejected') {
    return fail(res, 'This application already has a final decision, so it can no longer be withdrawn.');
  }

  await withTransaction(async (tx) => {
    await tx.exec("UPDATE applications SET status = 'withdrawn' WHERE application_id = ?", [aid]);
    await tx.exec(
      "INSERT INTO application_status_history (application_id, old_status, new_status, changed_by) VALUES (?,?,'withdrawn',?)",
      [aid, a.status, u.user_id],
    );
  });

  const updated = await queryOne<ApplicationRow>('SELECT * FROM applications WHERE application_id = ?', [aid]);
  ok(res, { application: serializeApplication(updated!) });
});

/* The applicant's own audit trail.

   Every status change was already written to application_status_history, in
   the same transaction as the change — but only the metrics page ever read
   those rows, so the person the record is about could not see when they were
   shortlisted, or that anything had changed at all if they missed the email.

   Visible to the applicant (their own application only) and to staff at the
   company that owns the posting. WHO DID IT is disclosed by audience, and the
   asymmetry is deliberate:

     · To the APPLICANT, never a name. They learn what was decided and when,
       which is what affects them.
     · To the EMPLOYER'S STAFF, the name — internal accountability is why
       changed_by is stored, and several recruiters share one applicant pool,
       so one picking up a colleague's work needs to know who moved this
       person already.

   Same rows either way; only `byName` differs. */
router.post('/history', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const aid = idOf(req.body?.id);

  const a = await queryOne<ApplicationRow & { company_id: number }>(
    `SELECT a.*, p.company_id
       FROM applications a
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE a.application_id = ?`, [aid],
  );

  /* One message for "no such application" and for "not yours", so this
     cannot be used to probe which application ids exist. */
  const mine = !!a && a.seeker_id === u.user_id;
  const atMyCompany = !!a
    && (u.role === 'recruiter' || u.role === 'admin')
    && a.company_id === u.company_id;
  if (!a || !(mine || atMyCompany)) return fail(res, 'Application not found.');

  /* An applicant reading their OWN history gets no names, even in the odd
     case where they also work at the company — the narrower disclosure wins. */
  const maySeeNames = atMyCompany && !mine;

  const rows = await query<{
    old_status: string | null; new_status: string; changed_at: unknown;
    changed_by: number | null; actor_name: string | null; reason: string | null;
  }>(
    `SELECT h.old_status, h.new_status, h.changed_at, h.changed_by, h.reason,
            u.full_name AS actor_name
       FROM application_status_history h
       LEFT JOIN users u ON u.user_id = h.changed_by
      WHERE h.application_id = ?
      ORDER BY h.changed_at ASC, h.history_id ASC`, [aid],
  );

  ok(res, {
    events: rows.map((r) => {
      const by = r.changed_by === a.seeker_id ? 'applicant' : 'employer';
      const e: Record<string, unknown> = {
        from: r.old_status,
        to: r.new_status,
        at: new Date(r.changed_at as string | number | Date).getTime(),
        by,
      };
      // Only ever set for the employer's own staff, and never for the
      // applicant's own action (that person is the applicant themselves —
      // the recruiter already knows who they are from the row they clicked).
      if (maySeeNames && by === 'employer' && r.actor_name) e['byName'] = r.actor_name;

      /* THE REASON GOES TO THE APPLICANT, unlike the name beside it.
         Built the other way round first. The argument for hiding it is real —
         a code its subject will read is one some recruiters will soften — but
         Chapter 1's stated problem is applicants who hear nothing at all, and
         a system that records why and then withholds it from the person whose
         plans depend on it argues against its own thesis. Someone who learns
         they were unreachable rather than unqualified can fix their number.

         What survives is the split between the DECISION and the DECIDER, which
         is why `byName` keeps the narrower gate and this does not. The wording
         differs by audience too: REASON_LABELS is filing language,
         APPLICANT_REASON_LABELS is written for the person it is about. */
      if (r.reason) e['reason'] = r.reason;
      return e;
    }),
  });
});

/* SCREENING NOTES — what a recruiter writes down while working a shortlist.
   "Called 3pm, no answer." "Wants 35k, budget is 28." "Referred by Ops."

   Without a place for these, HR keeps a spreadsheet beside the system, and a
   system people work beside instead of in is not the system. That is the whole
   justification for the feature; it screens nobody and scores nothing.

   Visible to the employer's own staff and to no one else — never to the
   applicant, on this route or any other. A note the subject may read is a note
   nobody writes honestly, and most of these are provisional by nature.        */
router.post('/notes', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const aid = idOf(req.body?.id);

  const a = await queryOne<{ company_id: number }>(
    `SELECT p.company_id FROM applications a
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE a.application_id = ?`, [aid],
  );
  if (!a || a.company_id !== u.company_id) return fail(res, 'Application not found.');

  const rows = await query<any>(
    `SELECT n.note_id, n.body, n.created_at, n.author_id, us.full_name AS author_name
       FROM application_notes n
       LEFT JOIN users us ON us.user_id = n.author_id
      WHERE n.application_id = ?
      ORDER BY n.created_at DESC, n.note_id DESC`, [aid],
  );

  ok(res, {
    notes: rows.map((r) => ({
      id: String(r.note_id),
      body: r.body,
      at: ts(r.created_at),
      authorName: r.author_name ?? 'A former colleague',
      mine: Number(r.author_id) === u.user_id,
    })),
  });
});

router.post('/note-add', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const aid = idOf(req.body?.id);
  const body = String(req.body?.body ?? '').trim().slice(0, 2000);
  if (!body) return fail(res, 'Write something first.');

  const a = await queryOne<{ company_id: number }>(
    `SELECT p.company_id FROM applications a
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE a.application_id = ?`, [aid],
  );
  if (!a || a.company_id !== u.company_id) return fail(res, 'Application not found.');

  const ins = await exec(
    'INSERT INTO application_notes (application_id, author_id, body) VALUES (?,?,?) RETURNING note_id',
    [aid, u.user_id, body],
  );
  ok(res, { id: String(ins.insertId) });
});

/* Only the author may delete, and only their own note. A colleague quietly
   removing someone else's observation would make the notes untrustworthy to
   the very people who have to rely on them. */
router.post('/note-delete', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const nid = idOf(req.body?.id);

  const n = await queryOne<{ author_id: number; company_id: number }>(
    `SELECT n.author_id, p.company_id
       FROM application_notes n
       JOIN applications a ON a.application_id = n.application_id
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE n.note_id = ?`, [nid],
  );
  if (!n || n.company_id !== u.company_id) return fail(res, 'Note not found.');
  if (Number(n.author_id) !== u.user_id) return fail(res, 'You can only delete your own notes.');

  await exec('DELETE FROM application_notes WHERE note_id = ?', [nid]);
  ok(res, {});
});

/* A recruiter's personal message to an applicant — typically the
   interview invitation after shortlisting. Deliberately transactional:
   it is one human writing to another about an application the seeker
   chose to submit, so the marketing-style opt-out doesn't apply. The
   reply-to is the recruiter, so the conversation continues over email. */
router.post('/invite', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const aid = idOf(req.body?.id);
  const message = String(req.body?.message ?? '').trim();
  if (message.length < 10) return fail(res, 'Write the applicant a short message first.');
  if (message.length > 2000) return fail(res, 'Keep the message under 2000 characters.');

  /* Optional interview time. When a start instant is given, it must parse
     and (to keep the calendar file sane) fall in a reasonable window. */
  let schedule: { startIso: string; durationMinutes?: number; location?: string } | undefined;
  const startRaw = req.body?.when;
  if (startRaw != null && String(startRaw).trim() !== '') {
    const start = new Date(String(startRaw));
    if (Number.isNaN(start.getTime())) return fail(res, 'That interview date and time could not be read.');
    const durationMinutes = Number(req.body?.durationMinutes);
    const location = String(req.body?.location ?? '').trim().slice(0, 200) || undefined;
    schedule = {
      startIso: start.toISOString(),
      durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? Math.min(durationMinutes, 24 * 60) : undefined,
      location,
    };
  }

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
    p.title, co?.company_name || 'the company', message, schedule,
  );
  if (!sent.ok) return fail(res, sent.error);
  ok(res, { sent: sent.sent });
});

export default router;
