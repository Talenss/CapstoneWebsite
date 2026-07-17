/* ResumeMatch PH — routes/resumes.ts
   list · get · save · delete · duplicate · set-active · upload · remove-file */
import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query, queryOne, exec, db } from '../db';
import { ResumeRow } from '../types';
import { ok, fail } from '../lib/http';
import { requireUser, requireRole } from '../lib/auth';
import { fetchResume, serializeResume, recruiterMayReadResume } from '../lib/serializers';
import { EDU_RANK, skillId } from '../lib/engine';
import { UPLOAD_DIR, MAX_UPLOAD, ALLOWED_MIME } from '../config';

const router = Router();
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: MAX_UPLOAD } });

router.post('/list', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const rows = await query<ResumeRow>('SELECT * FROM resumes WHERE user_id = ? ORDER BY updated_at DESC', [u.user_id]);
  ok(res, { resumes: await Promise.all(rows.map(serializeResume)) });
});

router.post('/get', async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;
  const id = Number(req.body?.id);
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

  const title = String(R.title ?? '').trim() || 'Untitled resume';
  const template = ['chronological', 'functional', 'combination'].includes(R.template) ? R.template : 'chronological';
  const p = R.personal && typeof R.personal === 'object' ? R.personal : {};

  const conn = await db().getConnection();
  try {
    await conn.beginTransaction();
    let id = R.id ? Number(R.id) : 0;

    if (id) {
      const [ownRows]: any = await conn.query('SELECT * FROM resumes WHERE resume_id=?', [id]);
      const own = ownRows[0];
      if (!own || own.user_id !== u.user_id) {
        await conn.rollback();
        return fail(res, 'You can only edit your own resumes.', 403);
      }
      await conn.query(
        'UPDATE resumes SET title=?, template_type=?, full_name=?, email=?, phone=?, address=?, summary=? WHERE resume_id=?',
        [title, template, p.fullName ?? '', p.email ?? '', p.phone ?? '', p.address ?? '', p.summary ?? '', id],
      );
    } else {
      const [insResult]: any = await conn.query(
        'INSERT INTO resumes (user_id, title, template_type, full_name, email, phone, address, summary) VALUES (?,?,?,?,?,?,?,?)',
        [u.user_id, title, template, p.fullName ?? '', p.email ?? '', p.phone ?? '', p.address ?? '', p.summary ?? ''],
      );
      id = insResult.insertId;
      if (u.active_resume_id === null) {
        await conn.query('UPDATE users SET active_resume_id = ? WHERE user_id = ?', [id, u.user_id]);
      }
    }

    // Children are replaced wholesale — simpler, and always consistent.
    await conn.query('DELETE FROM education WHERE resume_id = ?', [id]);
    await conn.query('DELETE FROM work_experience WHERE resume_id = ?', [id]);
    await conn.query('DELETE FROM certifications WHERE resume_id = ?', [id]);
    await conn.query('DELETE FROM resume_skills WHERE resume_id = ?', [id]);

    let i = 0;
    for (const e of R.education ?? []) {
      const lvl = Object.keys(EDU_RANK).includes(e.level) ? e.level : 'bachelor';
      await conn.query(
        'INSERT INTO education (resume_id, school, degree, level, year_grad, sort_order) VALUES (?,?,?,?,?,?)',
        [id, e.school ?? '', e.degree ?? '', lvl, e.year ?? '', i++],
      );
    }
    i = 0;
    for (const e of R.experience ?? []) {
      await conn.query(
        'INSERT INTO work_experience (resume_id, position, company, months, description, sort_order) VALUES (?,?,?,?,?,?)',
        [id, e.position ?? '', e.company ?? '', Number(e.months) || 0, e.description ?? '', i++],
      );
    }
    i = 0;
    for (const c of R.certifications ?? []) {
      await conn.query(
        'INSERT INTO certifications (resume_id, cert_name, year_taken, sort_order) VALUES (?,?,?,?)',
        [id, c.name ?? '', c.year ?? '', i++],
      );
    }
    for (const s of R.skills ?? []) {
      const trimmed = String(s).trim();
      if (!trimmed) continue;
      const sid = await skillId(trimmed);
      await conn.query('INSERT IGNORE INTO resume_skills (resume_id, skill_id) VALUES (?,?)', [id, sid]);
    }

    await conn.query('UPDATE resumes SET updated_at = NOW() WHERE resume_id = ?', [id]);
    await conn.commit();

    const saved = await fetchResume(id);
    ok(res, { resume: await serializeResume(saved!) });
  } catch (e: any) {
    await conn.rollback();
    fail(res, "Your resume couldn't be saved. Try again.", 500);
  } finally {
    conn.release();
  }
});

router.post('/delete', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const id = Number(req.body?.id);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Resume not found.');

  // A resume attached to an application can't be deleted — the recruiter
  // still needs to see exactly what was sent to them.
  const inUse = await queryOne('SELECT 1 FROM applications WHERE resume_id = ? LIMIT 1', [id]);
  if (inUse)
    return fail(res, "This resume is attached to an application, so it can't be deleted — the recruiter still needs to see exactly what you sent. Duplicate it and edit the copy instead.");

  if (r.own_file_path) {
    const p = path.join(UPLOAD_DIR, path.basename(r.own_file_path));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

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
  const id = Number(req.body?.id);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Resume not found.');

  const conn = await db().getConnection();
  try {
    await conn.beginTransaction();
    // the uploaded file is deliberately NOT copied — one file, one resume
    const [insResult]: any = await conn.query(
      `INSERT INTO resumes (user_id, title, template_type, full_name, email, phone, address, summary)
       SELECT user_id, CONCAT(title, " (copy)"), template_type, full_name, email, phone, address, summary
         FROM resumes WHERE resume_id = ?`, [id],
    );
    const newId = insResult.insertId;

    await conn.query(
      `INSERT INTO education (resume_id, school, degree, level, year_grad, sort_order)
       SELECT ?, school, degree, level, year_grad, sort_order FROM education WHERE resume_id = ?`, [newId, id],
    );
    await conn.query(
      `INSERT INTO work_experience (resume_id, position, company, months, description, sort_order)
       SELECT ?, position, company, months, description, sort_order FROM work_experience WHERE resume_id = ?`, [newId, id],
    );
    await conn.query(
      `INSERT INTO certifications (resume_id, cert_name, year_taken, sort_order)
       SELECT ?, cert_name, year_taken, sort_order FROM certifications WHERE resume_id = ?`, [newId, id],
    );
    await conn.query(
      `INSERT INTO resume_skills (resume_id, skill_id)
       SELECT ?, skill_id FROM resume_skills WHERE resume_id = ?`, [newId, id],
    );
    await conn.commit();

    const created = await fetchResume(newId);
    ok(res, { resume: await serializeResume(created!) });
  } catch (e) {
    await conn.rollback();
    fail(res, 'Copy failed. Try again.', 500);
  } finally {
    conn.release();
  }
});

router.post('/set-active', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const id = Number(req.body?.id);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Resume not found.');
  await exec('UPDATE users SET active_resume_id = ? WHERE user_id = ?', [id, u.user_id]);
  ok(res);
});

/* ---- the dual-resume model: the applicant's OWN file.
        Stored outside the web root. Never parsed. Never scored. ---- */
router.post('/upload', upload.single('file'), async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return;
  }
  const id = Number(req.body?.resume_id ?? 0);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return fail(res, 'Resume not found.');
  }

  if (!req.file) return fail(res, "That file didn't upload. Try again.");
  const f = req.file;
  const mime = f.mimetype;
  const ext = ALLOWED_MIME[mime];
  if (!ext) {
    fs.unlink(f.path, () => {});
    return fail(res, 'Upload a PDF, Word document, or image (JPG or PNG).');
  }

  // random name: the original filename never touches the filesystem
  const stored = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.renameSync(f.path, path.join(UPLOAD_DIR, stored));

  if (r.own_file_path) { // replace: bin the old one
    const old = path.join(UPLOAD_DIR, path.basename(r.own_file_path));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }

  await exec(
    'UPDATE resumes SET own_file_name=?, own_file_mime=?, own_file_size=?, own_file_path=?, own_file_uploaded_at=NOW() WHERE resume_id=?',
    [Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 200), mime, f.size, stored, id],
  );

  const updated = await serializeResume((await fetchResume(id))!);
  ok(res, { ownFile: updated.ownFile });
});

router.post('/remove-file', async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;
  const id = Number(req.body?.id);
  const r = await fetchResume(id);
  if (!r || r.user_id !== u.user_id) return fail(res, 'Resume not found.');

  if (r.own_file_path) {
    const p = path.join(UPLOAD_DIR, path.basename(r.own_file_path));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  await exec(
    'UPDATE resumes SET own_file_name=NULL, own_file_mime=NULL, own_file_size=NULL, own_file_path=NULL, own_file_uploaded_at=NULL WHERE resume_id=?',
    [id],
  );
  ok(res);
});

export default router;
