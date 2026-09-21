/* Linaw PH — routes/resumes.ts
   list · get · save · delete · duplicate · set-active · upload · remove-file */
import { asyncRouter } from '../lib/async-router';
import multer from 'multer';
import crypto from 'crypto';
import { query, queryOne, exec, withTransaction } from '../db';
import { ResumeRow } from '../types';
import { ok, fail, idOf } from '../lib/http';
import { requireUser, requireRole } from '../lib/auth';
import { fetchResume, prefetchResumeChildren, serializeResume, recruiterMayReadResume, parseHiddenSections } from '../lib/serializers';
import { EDU_RANK, EVIDENCE_KINDS, EvidenceKind, evidenceLabels, skillId, skillNorm } from '../lib/engine';
import { extractResume } from '../lib/extract';
import { MAX_UPLOAD, ALLOWED_MIME } from '../config';
import { putFile, deleteFile } from '../lib/storage';
import { sniffBytes, typeMatches } from '../lib/file-type';

const router = asyncRouter();
/* memoryStorage, not dest: the bytes go straight to lib/storage, which may
   be Supabase rather than this machine's disk. A 2 MB cap makes holding the
   upload in memory for the length of one request unremarkable. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });

router.post('/list', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const rows = await query<ResumeRow>('SELECT * FROM resumes WHERE user_id = ? ORDER BY updated_at DESC', [u.user_id]);
  const kids = await prefetchResumeChildren(rows.map((r) => r.resume_id));
  ok(res, { resumes: await Promise.all(rows.map((r) => serializeResume(r, kids))) });
});

router.post('/get', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const id = idOf(req.body?.id);
  const r = await fetchResume(id);
  if (!r) return fail(res, 'Resume not found.');

  if (u.role === 'recruiter') {
    if (!(await recruiterMayReadResume(u, id))) return fail(res, 'You can only view resumes submitted to your company.', 403);
  } else if (r.user_id !== u.user_id) {
    return fail(res, 'You can only view your own resumes.', 403);
  }
  ok(res, { resume: await serializeResume(r) });
});

router.post('/save', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const R = req.body?.resume;
  if (!R || typeof R !== 'object') return fail(res, 'Nothing to save.');

  const title = (String(R.title ?? '').trim() || 'Untitled resume').slice(0, 120);
  const template = ['chronological', 'functional', 'combination'].includes(R.template) ? R.template : 'chronological';
  // Kept in step with client/src/app/core/engine.ts DESIGNS, the ResumeDesign
  // union, and the CHECK constraint on resumes.design. An unknown value falls
  // back rather than failing the save, so a resume written by a newer build
  // still saves against an older server.
  // 'categorized' was this design's stored id before it was renamed to match
  // the name every screen shows. It is mapped rather than left to the fallback
  // below, because a browser still holding the old build would otherwise have
  // its save silently rewritten to 'classic' — losing the user's choice
  // without reporting anything.
  const askedDesign = R.design === 'categorized' ? 'rail' : R.design;
  const design = ['classic', 'modern', 'minimal', 'executive', 'banner', 'split', 'bar', 'rail',
    'traditional', 'clean', 'compact', 'senior', 'graduate', 'technical'].includes(askedDesign) ? askedDesign : 'classic';
  const p = R.personal && typeof R.personal === 'object' ? R.personal : {};

  // Section arrays are clamped before they reach the transaction. Each skill
  // costs one or two round trips through skillId(), so an unbounded array
  // would hold a pooled connection open for tens of thousands of queries and
  // permanently pollute the canonical skills table. These ceilings are far
  // above any real resume; the builder's own UI never approaches them.
  const cap = <T,>(v: unknown, n: number): T[] => (Array.isArray(v) ? v.slice(0, n) : []) as T[];
  const education = cap<any>(R.education, 20);
  const experience = cap<any>(R.experience, 30);
  const certifications = cap<any>(R.certifications, 30);
  const skills = cap<any>(R.skills, 100);
  const projects = cap<any>(R.projects, 20);
  const languages = cap<any>(R.languages, 20);
  const references = cap<any>(R.references, 10);
  const links = cap<any>(R.links, 10);

  /* EDUCATION AND SKILLS CANNOT BE SKIPPED.
   *
   * They are two of the three components every opening scores, so a resume
   * saved without them is one the engine can only ever score on experience —
   * it reaches a recruiter looking complete while carrying nothing for two
   * thirds of the weighting. The applicant is not told why, because from
   * their side nothing failed; the resume simply saved.
   *
   * Enforced HERE rather than only in the builder, because the builder is the
   * browser's copy of the rule and the browser is not where a rule lives. The
   * builder checks it too, so the applicant is stopped on the step that needs
   * them rather than by a message after a round trip.
   *
   * CONTENT, not the existence of a row. An entry object with every field
   * blank is what an applicant leaves behind by opening a section and typing
   * nothing, and counting it would let the rule be satisfied by a row nobody
   * filled in. Either school or degree is enough to show the entry is real. */
  const hasEducation = education.some(
    (e: any) => String(e?.school ?? '').trim() !== '' || String(e?.degree ?? '').trim() !== '');
  const hasSkills = skills.some((s: any) => String(s ?? '').trim() !== '');
  if (!hasEducation) {
    return fail(res, 'Add at least one education entry before saving — openings score education, and a resume without it cannot be matched fairly.');
  }
  if (!hasSkills) {
    return fail(res, 'Add at least one skill before saving — skills carry the largest share of every match score.');
  }

  /* SECTIONS THE APPLICANT SWITCHED OFF. parseHiddenSections keeps only the
     six names it knows, so education, experience and skills cannot be hidden
     by a hand-written request -- they are the three components every opening
     scores and the sheet would be unreadable without them. */
  const hiddenSections = parseHiddenSections(R.hiddenSections).join(',');

  /* WHERE EACH SKILL WAS USED. Accepted only when the kind is one we know and
     the label matches an entry ALREADY ON THIS RESUME — the point of the
     feature is that a source cannot be invented alongside the skill it is
     meant to justify, so free text is not an option.

     A link whose entry has since been renamed or deleted is DROPPED rather
     than kept or rejected. Keeping it would show a recruiter a source the
     resume no longer contains; rejecting the whole save would block an
     applicant from fixing a job title. Dropping it costs that one skill its
     full credit, and the builder shows it as unsourced the moment the resume
     is reopened, so nothing disappears quietly. */
  /* The uploaded document counts as a source too, but only while it is really
     attached — so its name is read from the stored row rather than taken from
     the payload, where a client could put anything. A resume being created has
     no file yet, which is why the builder attaches first and links after. */
  const attached = R.id
    ? await queryOne<{ own_file_name: string | null }>(
        'SELECT own_file_name FROM resumes WHERE resume_id = ? AND user_id = ?', [Number(R.id), u.user_id])
    : null;
  const labels = evidenceLabels({
    experience, projects, certifications, education,
    ownFile: attached?.own_file_name ? { name: attached.own_file_name } : null,
  });
  /* WAS THE APPLICANT ASKED? The builder always sends a skillEvidence key,
     empty or not, because it is the screen that asks. An import from an
     uploaded CV sends no such key — the applicant never saw the question.
     The engine already distinguishes the two (an absent map is full credit,
     an empty one is half), but the serializer emitted a map either way, so
     an imported CV was docked for declining a question never put to it. */
  const evidencePrompted = Object.prototype.hasOwnProperty.call(R, 'skillEvidence') ? 1 : 0;
  const rawEvidence = R.skillEvidence && typeof R.skillEvidence === 'object' ? R.skillEvidence : {};
  /* Each skill may name SEVERAL sources (a job and a school), so a value can be
     an array; the older single-object shape is still accepted. Every source is
     validated the same way — its kind is known and its ref is a label that
     actually exists elsewhere on this resume — and duplicates are folded, so a
     skill cannot point at the same entry twice or at one that was renamed or
     deleted. */
  const skillEvidence = new Map<string, { kind: EvidenceKind; ref: string }[]>();
  for (const [name, v] of Object.entries(rawEvidence as Record<string, any>)) {
    const raw = Array.isArray(v) ? v : v ? [v] : [];
    const sources: { kind: EvidenceKind; ref: string }[] = [];
    const seen = new Set<string>();
    for (const one of raw) {
      const kind = one?.kind as EvidenceKind;
      const ref = String(one?.ref ?? '').trim().slice(0, 200);
      if (!EVIDENCE_KINDS.includes(kind) || !ref) continue;
      if (!labels[kind].has(ref)) continue;
      const key = kind + '|' + ref;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ kind, ref });
    }
    if (sources.length) skillEvidence.set(skillNorm(name), sources);
  }

  // Ownership check up front so we can send a clean 403 (an error thrown
  // inside the transaction surfaces only as a generic 500).
  if (R.id) {
    const own = await queryOne<ResumeRow>('SELECT user_id FROM resumes WHERE resume_id = ?', [Number(R.id)]);
    if (!own || own.user_id !== u.user_id) return fail(res, 'You can only edit your own resumes.', 403);
  }

  /* ONE TITLE PER APPLICANT. The title is the only thing that tells two of
     an applicant's resumes apart: it is what the dashboard lists, what the
     "which resume?" picker on an application shows, and what a recruiter
     sees named against a submission. Two resumes both called "My resume"
     leave the applicant picking blind at the one moment it matters, and a
     wrong pick is not visible afterwards — the application simply carries
     the other document.

     Scoped to the owner, not global: two different people may of course both
     call theirs "My resume". Compared case-insensitively on the trimmed,
     already-truncated title, so "My Resume" does not slip past "my resume",
     and `<> ?` excludes the row being edited so re-saving under its own
     title is not mistaken for a collision. */
  const clash = await queryOne<{ resume_id: number }>(
    'SELECT resume_id FROM resumes WHERE user_id = ? AND LOWER(title) = LOWER(?) AND resume_id <> ?',
    [u.user_id, title, R.id ? Number(R.id) : 0],
  );
  if (clash) {
    return fail(res, `You already have a resume called “${title}”. Give this one a different title — it is how you tell them apart when you apply.`);
  }

  try {
    const savedId = await withTransaction(async (tx) => {
      let id = R.id ? Number(R.id) : 0;

      if (id) {
        await tx.exec(
          `UPDATE resumes SET title=?, template_type=?, design=?, full_name=?, email=?, phone=?,
             address=?, summary=?, headline=?, linkedin=?, portfolio=?, hidden_sections=?,
             evidence_prompted = GREATEST(evidence_prompted, ?) WHERE resume_id=?`,
          [title, template, design, p.fullName ?? '', p.email ?? '', p.phone ?? '', p.address ?? '', p.summary ?? '',
           String(p.headline ?? '').slice(0, 200), String(p.linkedin ?? '').slice(0, 300), String(p.portfolio ?? '').slice(0, 300),
           hiddenSections, evidencePrompted, id],
        );
      } else {
        const ins = await tx.exec(
          `INSERT INTO resumes (user_id, title, template_type, design, full_name, email, phone, address, summary,
             headline, linkedin, portfolio, hidden_sections, evidence_prompted)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING resume_id`,
          [u.user_id, title, template, design, p.fullName ?? '', p.email ?? '', p.phone ?? '', p.address ?? '', p.summary ?? '',
           String(p.headline ?? '').slice(0, 200), String(p.linkedin ?? '').slice(0, 300), String(p.portfolio ?? '').slice(0, 300),
           hiddenSections, evidencePrompted],
        );
        id = ins.insertId;
        if (u.active_resume_id === null) {
          await tx.exec('UPDATE users SET active_resume_id = ? WHERE user_id = ?', [id, u.user_id]);
        }
      }

      /* WHEN EACH SKILL FIRST APPEARED, preserved across a save.
       *
       * Children are replaced wholesale below, which is simple and always
       * consistent — but it means a skill row is deleted and recreated every
       * time the resume is saved for any reason. A first-seen timestamp with a
       * database default would therefore be reset by an unrelated edit and
       * record nothing at all. So the existing timestamps are read before the
       * delete and carried onto the rows that come back; only a genuinely new
       * skill gets today's date.
       *
       * This is not a judgement about the applicant. It exists so a recruiter
       * can see that three of four required skills were added the same day as
       * the application and ask about it at interview, which is a question a
       * person is qualified to weigh and the software is not. */
      const priorSkillDates = new Map<number, string>();
      for (const row of await tx.query<{ skill_id: number; added_at: string }>(
        'SELECT skill_id, added_at FROM resume_skills WHERE resume_id = ?', [id],
      )) priorSkillDates.set(Number(row.skill_id), row.added_at);

      // Children are replaced wholesale — simpler, and always consistent.
      await tx.exec('DELETE FROM education WHERE resume_id = ?', [id]);
      await tx.exec('DELETE FROM work_experience WHERE resume_id = ?', [id]);
      await tx.exec('DELETE FROM certifications WHERE resume_id = ?', [id]);
      await tx.exec('DELETE FROM resume_skills WHERE resume_id = ?', [id]);
      await tx.exec('DELETE FROM projects WHERE resume_id = ?', [id]);
      await tx.exec('DELETE FROM resume_languages WHERE resume_id = ?', [id]);
      await tx.exec('DELETE FROM resume_references WHERE resume_id = ?', [id]);
      await tx.exec('DELETE FROM resume_links WHERE resume_id = ?', [id]);

      let i = 0;
      for (const e of education) {
        // An unrecognised level means we do not know it, so it claims nothing
        // (rank 0). Defaulting to 'bachelor' invented a degree for anyone
        // whose payload was blank, partial, or hand-made.
        const lvl = Object.keys(EDU_RANK).includes(e.level) ? e.level : 'none';
        await tx.exec(
          `INSERT INTO education (resume_id, school, degree, level, year_grad, field, location, honors, sort_order)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          [id, String(e.school ?? '').slice(0, 160), String(e.degree ?? '').slice(0, 160), lvl, String(e.year ?? '').slice(0, 20),
           String(e.field ?? '').slice(0, 160), String(e.location ?? '').slice(0, 160), String(e.honors ?? '').slice(0, 200), i++],
        );
      }
      i = 0;
      for (const e of experience) {
        await tx.exec(
          `INSERT INTO work_experience (resume_id, position, company, months, description,
             location, start_date, end_date, is_current, bullets, sort_order)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [id, String(e.position ?? '').slice(0, 160), String(e.company ?? '').slice(0, 160),
           Math.max(0, Math.min(720, Number(e.months) || 0)), String(e.description ?? '').slice(0, 2000),
           String(e.location ?? '').slice(0, 160), String(e.startDate ?? '').slice(0, 40), String(e.endDate ?? '').slice(0, 40),
           e.current ? 1 : 0,
           // Stored newline-separated; blanks dropped so no empty bullet
           // can ever reach the sheet. Capped like every other list.
           (Array.isArray(e.bullets) ? e.bullets : []).slice(0, 12)
             .map((b: unknown) => String(b ?? '').trim().slice(0, 300)).filter(Boolean).join('\n'),
           i++],
        );
      }
      i = 0;
      for (const c of certifications) {
        await tx.exec(
          `INSERT INTO certifications (resume_id, cert_name, year_taken, issuer, credential_id, sort_order)
             VALUES (?,?,?,?,?,?)`,
          [id, String(c.name ?? '').slice(0, 160), String(c.year ?? '').slice(0, 20),
           String(c.issuer ?? '').slice(0, 200), String(c.credentialId ?? '').slice(0, 120), i++],
        );
      }
      i = 0;
      for (const x of projects) {
        const name = String(x.name ?? '').trim().slice(0, 200);
        if (!name) continue;   // a nameless project would print as an empty entry
        await tx.exec(
          `INSERT INTO projects (resume_id, proj_name, proj_role, start_date, end_date, description, link, sort_order)
             VALUES (?,?,?,?,?,?,?,?)`,
          [id, name, String(x.role ?? '').slice(0, 160), String(x.startDate ?? '').slice(0, 40),
           String(x.endDate ?? '').slice(0, 40), String(x.description ?? '').slice(0, 2000),
           String(x.link ?? '').slice(0, 300), i++],
        );
      }
      i = 0;
      for (const x of languages) {
        const name = String(x.name ?? '').trim().slice(0, 120);
        if (!name) continue;
        await tx.exec(
          'INSERT INTO resume_languages (resume_id, lang_name, proficiency, sort_order) VALUES (?,?,?,?)',
          [id, name, String(x.proficiency ?? '').slice(0, 120), i++],
        );
      }
      i = 0;
      for (const x of references) {
        const name = String(x.name ?? '').trim().slice(0, 160);
        if (!name) continue;
        await tx.exec(
          `INSERT INTO resume_references (resume_id, ref_name, position, company, email, phone, sort_order)
             VALUES (?,?,?,?,?,?,?)`,
          [id, name, String(x.position ?? '').slice(0, 160), String(x.company ?? '').slice(0, 160),
           String(x.email ?? '').slice(0, 190), String(x.phone ?? '').slice(0, 40), i++],
        );
      }
      i = 0;
      for (const x of links) {
        /* Only http and https are stored. A `javascript:` URL would run in the
           recruiter's browser the moment they clicked it, and a relative path
           would point back at this site rather than at the applicant's work.
           An address that is neither is dropped, the same way a nameless
           project is -- the builder marks it invalid while it is being typed,
           so nothing is lost silently here. */
        const url = String(x.url ?? '').trim().slice(0, 500);
        if (!/^https?:\/\/\S+$/i.test(url)) continue;
        await tx.exec(
          'INSERT INTO resume_links (resume_id, label, url, sort_order) VALUES (?,?,?,?)',
          [id, String(x.label ?? '').trim().slice(0, 120), url, i++],
        );
      }

      for (const s of skills) {
        const trimmed = String(s).trim().slice(0, 80);
        if (!trimmed) continue;
        const sid = await skillId(trimmed);
        const firstSeen = priorSkillDates.get(sid) ?? null;   // null → the column default, i.e. now
        // Looked up on the normalized name so "JS" and "JavaScript" reach the
        // same row the engine will later score — the same folding skillId did.
        const sources = skillEvidence.get(skillNorm(trimmed)) ?? [];
        const first = sources[0] ?? null;   // mirrored into the single pair for old readers
        await tx.exec(
          `INSERT INTO resume_skills (resume_id, skill_id, added_at, evidence_kind, evidence_ref, evidence_sources)
           VALUES (?,?, COALESCE(?::timestamptz, now()), ?, ?, ?::jsonb) ON CONFLICT DO NOTHING`,
          [id, sid, firstSeen, first?.kind ?? null, first?.ref ?? null,
           sources.length ? JSON.stringify(sources) : null],
        );
      }

      await tx.exec('UPDATE resumes SET updated_at = NOW() WHERE resume_id = ?', [id]);
      return id;
    });

    const saved = await fetchResume(savedId);
    ok(res, { resume: await serializeResume(saved!) });
  } catch (e: any) {
    fail(res, "Your resume couldn't be saved. Try again.", 500);
  }
});

router.post('/delete', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const id = idOf(req.body?.id);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Resume not found.');

  // A resume attached to an application can't be deleted — the recruiter
  // still needs to see exactly what was sent to them.
  const inUse = await queryOne('SELECT 1 FROM applications WHERE resume_id = ? LIMIT 1', [id]);
  if (inUse)
    return fail(res, "This resume is attached to an application, so it can't be deleted. The recruiter still needs to see exactly what you sent. Duplicate it and edit the copy instead.");

  if (r.own_file_path) await deleteFile(r.own_file_path);

  await exec('UPDATE users SET active_resume_id = NULL WHERE active_resume_id = ?', [id]);
  await exec('DELETE FROM resumes WHERE resume_id = ?', [id]);

  // promote whatever is left, so the dashboard is never left with nothing active
  const next = await queryOne<{ resume_id: number }>(
    'SELECT resume_id FROM resumes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [u.user_id],
  );
  if (next) await exec('UPDATE users SET active_resume_id = ? WHERE user_id = ?', [next.resume_id, u.user_id]);

  ok(res);
});

router.post('/duplicate', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const id = idOf(req.body?.id);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Resume not found.');

  /* The copy needs a title no other resume of this applicant holds, or it
     would create exactly the collision /save now refuses — and the applicant
     could not then save the copy at all without first renaming it. Walks
     "(copy)", "(copy 2)", "(copy 3)" ... until one is free, matching
     case-insensitively because that is how the guard compares. Truncated to
     the column's 120 from the LEFT of the base name, so the suffix that makes
     it unique is never the part that gets cut off. */
  const taken = new Set(
    (await query<{ title: string }>('SELECT title FROM resumes WHERE user_id = ?', [u.user_id]))
      .map((row) => row.title.trim().toLowerCase()),
  );
  const copyTitle = ((): string => {
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
      const candidate = (r.title.trim().slice(0, 120 - suffix.length) + suffix).slice(0, 120);
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  })();

  try {
    const newId = await withTransaction(async (tx) => {
      /* EVERY COLUMN AND EVERY SECTION, not a subset. "Duplicate it and edit
         the copy" is the answer the delete route gives an applicant whose
         resume is locked to an application, so a copy that quietly arrived
         missing its projects or its contact links would lose work at exactly
         the moment the applicant was told it was safe.

         The uploaded file is the one deliberate exception: one file, one
         resume, so the copy starts with no attachment. */
      const ins = await tx.exec(
        `INSERT INTO resumes (user_id, title, template_type, design, full_name, email, phone,
           address, summary, headline, linkedin, portfolio, hidden_sections, evidence_prompted)
         SELECT user_id, ?, template_type, design, full_name, email, phone,
           address, summary, headline, linkedin, portfolio, hidden_sections, evidence_prompted
           FROM resumes WHERE resume_id = ? RETURNING resume_id`, [copyTitle, id],
      );
      const nid = ins.insertId;

      await tx.exec(
        `INSERT INTO education (resume_id, school, degree, level, year_grad, field, location, honors, sort_order)
         SELECT ?, school, degree, level, year_grad, field, location, honors, sort_order
           FROM education WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        `INSERT INTO work_experience (resume_id, position, company, months, description,
           location, start_date, end_date, is_current, bullets, sort_order)
         SELECT ?, position, company, months, description,
           location, start_date, end_date, is_current, bullets, sort_order
           FROM work_experience WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        `INSERT INTO certifications (resume_id, cert_name, year_taken, issuer, credential_id, sort_order)
         SELECT ?, cert_name, year_taken, issuer, credential_id, sort_order
           FROM certifications WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        `INSERT INTO projects (resume_id, proj_name, proj_role, start_date, end_date, description, link, sort_order)
         SELECT ?, proj_name, proj_role, start_date, end_date, description, link, sort_order
           FROM projects WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        `INSERT INTO resume_languages (resume_id, lang_name, proficiency, sort_order)
         SELECT ?, lang_name, proficiency, sort_order FROM resume_languages WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        `INSERT INTO resume_references (resume_id, ref_name, position, company, email, phone, sort_order)
         SELECT ?, ref_name, position, company, email, phone, sort_order
           FROM resume_references WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        `INSERT INTO resume_links (resume_id, label, url, sort_order)
         SELECT ?, label, url, sort_order FROM resume_links WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        /* The copy carries the sources across. A duplicated resume is the same
           claims under a new title — dropping the evidence would score the
           copy lower than the original for no reason the applicant could see.
           added_at deliberately does NOT come along: this resume is new, and
           its skills genuinely first appear on it today. */
        `INSERT INTO resume_skills (resume_id, skill_id, evidence_kind, evidence_ref, evidence_sources)
         SELECT ?, skill_id, evidence_kind, evidence_ref, evidence_sources
           FROM resume_skills WHERE resume_id = ?`, [nid, id],
      );
      return nid;
    });

    const created = await fetchResume(newId);
    ok(res, { resume: await serializeResume(created!) });
  } catch (e) {
    fail(res, 'Copy failed. Try again.', 500);
  }
});

router.post('/set-active', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const id = idOf(req.body?.id);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Resume not found.');
  await exec('UPDATE users SET active_resume_id = ? WHERE user_id = ?', [id, u.user_id]);
  ok(res);
});

/* ---- the dual-resume model: the applicant's OWN file.
        Stored outside the web root, and read into structured fields on
        upload so the engine can score it too. ---- */
/* requireSeekerBeforeUpload runs BEFORE multer, so an anonymous caller is
   turned away without ever writing a 2 MB temp file to disk. Multer used to
   run first, which let an unauthenticated script churn the upload directory
   for free on every request. */
const requireSeekerBeforeUpload: import('express').RequestHandler = async (req, res, next) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return; // requireRole has already answered 401/403
  next();
};

router.post('/upload', requireSeekerBeforeUpload, upload.single('file'), async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const id = idOf(req.body?.resume_id);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Resume not found.');

  if (!req.file) return fail(res, "That file didn't upload. Try again.");
  const f = req.file;
  const mime = f.mimetype;
  const ext = ALLOWED_MIME[mime];
  if (!ext) return fail(res, 'Upload a PDF, Word document, or image (JPG or PNG).');

  // The declared Content-Type is the CLIENT's claim. Confirm it against the
  // file's actual leading bytes, so an arbitrary blob cannot be stored as a
  // .pdf and served back later under a PDF content type.
  const actual = sniffBytes(f.buffer);
  if (!actual || !typeMatches(actual, ext)) {
    return fail(res, "That file isn't a readable PDF, Word document, or image. Try saving it again and re-uploading.");
  }

  // random name: the original filename never touches the filesystem
  const stored = crypto.randomBytes(16).toString('hex') + '.' + ext;
  /* Store BEFORE the row is updated. If storage fails the resume still points
     at the previous file, which is a worse resume but an honest one — the
     alternative is a row naming an object that was never written. */
  try {
    await putFile(stored, f.buffer, mime);
  } catch (e: any) {
    console.error('Upload storage failed:', e?.message || e);
    return fail(res, "That file couldn't be saved right now. Try again in a moment.");
  }

  const previous = r.own_file_path; // binned after the row no longer refers to it

  await exec(
    `UPDATE resumes SET own_file_name=?, own_file_mime=?, own_file_size=?, own_file_path=?,
       own_file_uploaded_at=NOW(), own_file_extract=NULL, own_file_extract_status=NULL, own_file_extract_at=NULL
     WHERE resume_id=?`,
    [Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 200), mime, f.size, stored, id],
  );

  /* Read the document into structured fields so the engine can score it.
     The old extraction is cleared above first: a stale reading of the
     PREVIOUS file, scored against this one, is worse than none.

     This runs inline rather than in the background because the applicant is
     waiting on this response and the number is the point of the upload. It
     cannot fail the upload, though — extractResume never throws, and every
     failure is recorded as a status, so the file is still stored and still
     sent to the recruiter even when nothing could be read out of it. */
  const extract = await extractResume(f.buffer, mime, f.originalname || 'resume');
  await exec(
    'UPDATE resumes SET own_file_extract=?, own_file_extract_status=?, own_file_extract_at=NOW() WHERE resume_id=?',
    [extract.resume ? JSON.stringify(extract.resume) : null, extract.status, id],
  );

  if (previous) await deleteFile(previous);

  const updated = await serializeResume((await fetchResume(id))!);
  ok(res, { ownFile: updated.ownFile, extractStatus: extract.status, extractMessage: extract.message ?? null });
});

router.post('/remove-file', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const id = idOf(req.body?.id);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Resume not found.');

  if (r.own_file_path) await deleteFile(r.own_file_path);
  await exec(
    'UPDATE resumes SET own_file_name=NULL, own_file_mime=NULL, own_file_size=NULL, own_file_path=NULL, own_file_uploaded_at=NULL WHERE resume_id=?',
    [id],
  );
  ok(res);
});

export default router;
