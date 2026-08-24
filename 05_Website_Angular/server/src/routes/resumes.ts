/* ResumeMatch PH — routes/resumes.ts
   list · get · save · delete · duplicate · set-active · upload · remove-file */
import { asyncRouter } from '../lib/async-router';
import multer from 'multer';
import crypto from 'crypto';
import { query, queryOne, exec, withTransaction } from '../db';
import { ResumeRow } from '../types';
import { ok, fail, idOf } from '../lib/http';
import { requireUser, requireRole } from '../lib/auth';
import { fetchResume, serializeResume, recruiterMayReadResume } from '../lib/serializers';
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
  ok(res, { resumes: await Promise.all(rows.map(serializeResume)) });
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
  const design = ['classic', 'modern', 'minimal', 'executive', 'banner', 'split', 'bar', 'categorized',
    'traditional', 'clean', 'compact', 'senior', 'graduate', 'technical'].includes(R.design) ? R.design : 'classic';
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
  const labels = evidenceLabels({ experience, projects, certifications, education });
  const rawEvidence = R.skillEvidence && typeof R.skillEvidence === 'object' ? R.skillEvidence : {};
  const skillEvidence = new Map<string, { kind: EvidenceKind; ref: string }>();
  for (const [name, v] of Object.entries(rawEvidence as Record<string, any>)) {
    const kind = v?.kind as EvidenceKind;
    const ref = String(v?.ref ?? '').trim().slice(0, 200);
    if (!EVIDENCE_KINDS.includes(kind) || !ref) continue;
    if (!labels[kind].has(ref)) continue;
    skillEvidence.set(skillNorm(name), { kind, ref });
  }

  // Ownership check up front so we can send a clean 403 (an error thrown
  // inside the transaction surfaces only as a generic 500).
  if (R.id) {
    const own = await queryOne<ResumeRow>('SELECT user_id FROM resumes WHERE resume_id = ?', [Number(R.id)]);
    if (!own || own.user_id !== u.user_id) return fail(res, 'You can only edit your own resumes.', 403);
  }

  try {
    const savedId = await withTransaction(async (tx) => {
      let id = R.id ? Number(R.id) : 0;

      if (id) {
        await tx.exec(
          `UPDATE resumes SET title=?, template_type=?, design=?, full_name=?, email=?, phone=?,
             address=?, summary=?, headline=?, linkedin=?, portfolio=? WHERE resume_id=?`,
          [title, template, design, p.fullName ?? '', p.email ?? '', p.phone ?? '', p.address ?? '', p.summary ?? '',
           String(p.headline ?? '').slice(0, 200), String(p.linkedin ?? '').slice(0, 300), String(p.portfolio ?? '').slice(0, 300), id],
        );
      } else {
        const ins = await tx.exec(
          `INSERT INTO resumes (user_id, title, template_type, design, full_name, email, phone, address, summary,
             headline, linkedin, portfolio) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING resume_id`,
          [u.user_id, title, template, design, p.fullName ?? '', p.email ?? '', p.phone ?? '', p.address ?? '', p.summary ?? '',
           String(p.headline ?? '').slice(0, 200), String(p.linkedin ?? '').slice(0, 300), String(p.portfolio ?? '').slice(0, 300)],
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

      for (const s of skills) {
        const trimmed = String(s).trim().slice(0, 80);
        if (!trimmed) continue;
        const sid = await skillId(trimmed);
        const firstSeen = priorSkillDates.get(sid) ?? null;   // null → the column default, i.e. now
        // Looked up on the normalized name so "JS" and "JavaScript" reach the
        // same row the engine will later score — the same folding skillId did.
        const ev = skillEvidence.get(skillNorm(trimmed)) ?? null;
        await tx.exec(
          `INSERT INTO resume_skills (resume_id, skill_id, added_at, evidence_kind, evidence_ref)
           VALUES (?,?, COALESCE(?::timestamptz, now()), ?, ?) ON CONFLICT DO NOTHING`,
          [id, sid, firstSeen, ev?.kind ?? null, ev?.ref ?? null],
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
    return fail(res, "This resume is attached to an application, so it can't be deleted — the recruiter still needs to see exactly what you sent. Duplicate it and edit the copy instead.");

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

  try {
    const newId = await withTransaction(async (tx) => {
      // the uploaded file is deliberately NOT copied — one file, one resume
      const ins = await tx.exec(
        `INSERT INTO resumes (user_id, title, template_type, design, full_name, email, phone, address, summary)
         SELECT user_id, title || ' (copy)', template_type, design, full_name, email, phone, address, summary
           FROM resumes WHERE resume_id = ? RETURNING resume_id`, [id],
      );
      const nid = ins.insertId;

      await tx.exec(
        `INSERT INTO education (resume_id, school, degree, level, year_grad, sort_order)
         SELECT ?, school, degree, level, year_grad, sort_order FROM education WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        `INSERT INTO work_experience (resume_id, position, company, months, description, sort_order)
         SELECT ?, position, company, months, description, sort_order FROM work_experience WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        `INSERT INTO certifications (resume_id, cert_name, year_taken, sort_order)
         SELECT ?, cert_name, year_taken, sort_order FROM certifications WHERE resume_id = ?`, [nid, id],
      );
      await tx.exec(
        /* The copy carries the sources across. A duplicated resume is the same
           claims under a new title — dropping the evidence would score the
           copy lower than the original for no reason the applicant could see.
           added_at deliberately does NOT come along: this resume is new, and
           its skills genuinely first appear on it today. */
        `INSERT INTO resume_skills (resume_id, skill_id, evidence_kind, evidence_ref)
         SELECT ?, skill_id, evidence_kind, evidence_ref FROM resume_skills WHERE resume_id = ?`, [nid, id],
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
