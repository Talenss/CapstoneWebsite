/* ============================================================
   SERIALIZERS — DB rows → the exact JSON shape assets/api.js (and
   the Angular ApiService) expect. IDs are cast to strings so the
   front end can compare with === the same way demo mode does.
   Port of api/_lib.php's serialize_*() functions.
   ============================================================ */
import { query, queryOne } from '../db';
import { UserRow, CompanyRow, ResumeRow, PostingRow, ApplicationRow } from '../types';

// node-postgres returns TIMESTAMP/TIMESTAMPTZ columns as JS Date objects;
// accept those, or a 'YYYY-MM-DD HH:MM:SS' string, and return epoch millis.
export function ts(v: string | Date | null): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  return new Date(v.replace(' ', 'T')).getTime();
}

export function serializeUser(u: UserRow | null): any {
  if (!u) return null;
  const out: any = {
    id: String(u.user_id),
    role: u.role,
    name: u.full_name,
    email: u.email,
    createdAt: ts(u.created_at),
    // undefined can happen on rows loaded before the migration ran; the
    // feature defaults to on, matching the column default
    emailNotifications: u.email_notifications === undefined ? true : !!u.email_notifications,
  };
  if (u.role === 'seeker') {
    out.activeResumeId = u.active_resume_id !== null ? String(u.active_resume_id) : null;
  } else if (u.role === 'recruiter') {
    out.companyId = u.company_id !== null ? String(u.company_id) : null;
    out.position = u.position_title;
    out.verified = !!u.verified;
  }
  return out; // password_hash is never included
}

export function serializeCompany(c: CompanyRow): any {
  return {
    id: String(c.company_id),
    name: c.company_name,
    industry: c.industry,
    location: c.location,
    about: c.about,
    website: c.website,
  };
}

export async function serializeResume(r: ResumeRow): Promise<any> {
  const id = r.resume_id;

  const edu = await query<{ school: string; degree: string; level: string; year_grad: string }>(
    'SELECT school, degree, level, year_grad FROM education WHERE resume_id=? ORDER BY sort_order, education_id',
    [id],
  );
  const education = edu.map((e) => ({ school: e.school, degree: e.degree, level: e.level, year: e.year_grad }));

  const exp = await query<{ position: string; company: string; months: number; description: string }>(
    'SELECT position, company, months, description FROM work_experience WHERE resume_id=? ORDER BY sort_order, experience_id',
    [id],
  );
  const experience = exp.map((e) => ({
    position: e.position, company: e.company, months: Number(e.months), description: e.description,
  }));

  const sk = await query<{ skill_name: string }>(
    'SELECT s.skill_name FROM resume_skills rs JOIN skills s ON s.skill_id=rs.skill_id WHERE rs.resume_id=? ORDER BY s.skill_name',
    [id],
  );
  const skills = sk.map((r2) => r2.skill_name);

  const ce = await query<{ cert_name: string; year_taken: string }>(
    'SELECT cert_name, year_taken FROM certifications WHERE resume_id=? ORDER BY sort_order, certification_id',
    [id],
  );
  const certifications = ce.map((c) => ({ name: c.cert_name, year: c.year_taken }));

  // The uploaded file: metadata only. The bytes are served by /api/file,
  // which checks who is asking. There is no public URL to this document.
  const ownFile = r.own_file_name
    ? {
        name: r.own_file_name,
        mime: r.own_file_mime,
        size: Number(r.own_file_size),
        uploadedAt: ts(r.own_file_uploaded_at),
      }
    : null;

  return {
    id: String(id),
    userId: String(r.user_id),
    title: r.title,
    template: r.template_type,
    design: r.design ?? 'classic',
    personal: {
      fullName: r.full_name, email: r.email, phone: r.phone, address: r.address, summary: r.summary,
    },
    education, experience, skills, certifications, ownFile,
    updatedAt: ts(r.updated_at),
  };
}

/** True when the posting's optional "apply by" date is in the past
 *  (deadline day itself still accepts applications). */
export function postingExpired(p: PostingRow): boolean {
  if (!p.application_deadline) return false;
  const today = new Date().toISOString().slice(0, 10);
  return String(p.application_deadline).slice(0, 10) < today;
}

export async function serializePosting(p: PostingRow, withCompany = true): Promise<any> {
  const st = await query<{ skill_name: string }>(
    'SELECT s.skill_name FROM posting_skills ps JOIN skills s ON s.skill_id=ps.skill_id WHERE ps.posting_id=? ORDER BY s.skill_name',
    [p.posting_id],
  );

  const out: any = {
    id: String(p.posting_id),
    companyId: String(p.company_id),
    title: p.title,
    department: p.department,
    employmentType: p.employment_type,
    description: p.description,
    skills: st.map((r) => r.skill_name),
    educationLevel: p.education_level,
    minExperienceMonths: Number(p.min_experience_months),
    deadline: p.application_deadline || null,
    // past-deadline postings stop accepting applications without anyone
    // having to remember to close them (see postingExpired)
    expired: postingExpired(p),
    status: p.status,
    createdAt: ts(p.created_at),
  };

  if (withCompany) {
    const row = await queryOne<CompanyRow>('SELECT * FROM companies WHERE company_id=?', [p.company_id]);
    if (row) out.company = serializeCompany(row);
  }
  return out;
}

export function serializeApplication(a: ApplicationRow): any {
  return {
    id: String(a.application_id),
    seekerId: String(a.seeker_id),
    resumeId: String(a.resume_id),
    postingId: String(a.posting_id),
    status: a.status,
    appliedAt: ts(a.applied_at),
    // The score as it stood when they applied. Exposed so the client model
    // matches demo mode, and so the interface can show the applicant the
    // same number they saw rather than one recomputed since.
    scoreSnapshot: a.score_snapshot == null ? null : Number(a.score_snapshot),
  };
}

/* ---------- helpers ---------- */
export async function fetchResume(id: number): Promise<ResumeRow | null> {
  return queryOne<ResumeRow>('SELECT * FROM resumes WHERE resume_id=?', [id]);
}
export async function fetchPosting(id: number): Promise<PostingRow | null> {
  return queryOne<PostingRow>('SELECT * FROM job_postings WHERE posting_id=?', [id]);
}

/** May this recruiter read this resume? Only if it was actually
 *  submitted to one of their company's openings. */
export async function recruiterMayReadResume(recruiter: UserRow, resumeId: number): Promise<boolean> {
  const row = await queryOne(
    `SELECT 1 FROM applications a
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE a.resume_id = ? AND p.company_id = ? LIMIT 1`,
    [resumeId, recruiter.company_id],
  );
  return !!row;
}
