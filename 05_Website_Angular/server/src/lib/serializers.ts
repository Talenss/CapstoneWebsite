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
    firstName: u.first_name,
    lastName: u.last_name,
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

/* ============================================================
   BATCHED CHILD ROWS, for lists.

   serializeResume runs seven child queries — education, experience, skills,
   certifications, projects, languages, references. That is fine for one
   resume and quadratic-feeling for a list: the recruiter's ranked applicant
   view called it once per applicant, so a posting with 302 applications cost
   roughly 3,600 sequential round trips and took 1.6 seconds of pure database
   latency. Measured, not estimated, on a seeded 302-applicant posting.

   prefetchResumeChildren() runs those same seven queries ONCE for a whole set
   of resume ids and buckets the rows by resume. serializeResume takes the
   bundle as an optional second argument and reads from it instead of going
   back to the database. The output is byte-for-byte what it was — the mapping
   below is the same code either way — so nothing downstream has to change.
   ============================================================ */
export interface ResumeChildren {
  education: Map<number, any[]>;
  experience: Map<number, any[]>;
  skills: Map<number, any[]>;
  certifications: Map<number, any[]>;
  projects: Map<number, any[]>;
  languages: Map<number, any[]>;
  references: Map<number, any[]>;
}

const bucket = (rows: any[]): Map<number, any[]> => {
  const m = new Map<number, any[]>();
  for (const row of rows) {
    const k = Number(row.resume_id);
    const list = m.get(k);
    if (list) list.push(row); else m.set(k, [row]);
  }
  return m;
};

export async function prefetchResumeChildren(ids: number[]): Promise<ResumeChildren> {
  const empty = (): ResumeChildren => ({
    education: new Map(), experience: new Map(), skills: new Map(),
    certifications: new Map(), projects: new Map(), languages: new Map(), references: new Map(),
  });
  if (!ids.length) return empty();
  /* ORDER BY carries resume_id first so each bucket comes out in exactly the
     order the per-resume query produced, which is what keeps the serialized
     output identical. */
  const [edu, exp, sk, ce, pj, lg, rf] = await Promise.all([
    query<any>(`SELECT resume_id, school, degree, level, year_grad, field, location, honors
                  FROM education WHERE resume_id = ANY(?) ORDER BY resume_id, sort_order, education_id`, [ids]),
    query<any>(`SELECT resume_id, position, company, months, description, location, start_date, end_date, is_current, bullets
                  FROM work_experience WHERE resume_id = ANY(?) ORDER BY resume_id, sort_order, experience_id`, [ids]),
    query<any>(`SELECT rs.resume_id, s.skill_name, rs.added_at, rs.evidence_kind, rs.evidence_ref
                  FROM resume_skills rs JOIN skills s ON s.skill_id = rs.skill_id
                 WHERE rs.resume_id = ANY(?) ORDER BY rs.resume_id, s.skill_name`, [ids]),
    query<any>(`SELECT resume_id, cert_name, year_taken, issuer, credential_id
                  FROM certifications WHERE resume_id = ANY(?) ORDER BY resume_id, sort_order, certification_id`, [ids]),
    query<any>(`SELECT resume_id, proj_name, proj_role, start_date, end_date, description, link
                  FROM projects WHERE resume_id = ANY(?) ORDER BY resume_id, sort_order, project_id`, [ids]),
    query<any>(`SELECT resume_id, lang_name, proficiency
                  FROM resume_languages WHERE resume_id = ANY(?) ORDER BY resume_id, sort_order, language_id`, [ids]),
    query<any>(`SELECT resume_id, ref_name, position, company, email, phone
                  FROM resume_references WHERE resume_id = ANY(?) ORDER BY resume_id, sort_order, reference_id`, [ids]),
  ]);
  return {
    education: bucket(edu), experience: bucket(exp), skills: bucket(sk),
    certifications: bucket(ce), projects: bucket(pj), languages: bucket(lg), references: bucket(rf),
  };
}

export async function serializeResume(r: ResumeRow, pre?: ResumeChildren): Promise<any> {
  const id = r.resume_id;

  /* `level` and `months` below are the two fields the matching engine reads
     (with the flat skills list). Everything else on these rows is for the
     printed sheet and is never scored. */
  const edu = pre ? (pre.education.get(id) ?? []) : await query<any>(
    `SELECT school, degree, level, year_grad, field, location, honors
       FROM education WHERE resume_id=? ORDER BY sort_order, education_id`,
    [id],
  );
  const education = edu.map((e) => ({
    school: e.school, degree: e.degree, level: e.level, year: e.year_grad,
    ...(e.field ? { field: e.field } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.honors ? { honors: e.honors } : {}),
  }));

  const exp = pre ? (pre.experience.get(id) ?? []) : await query<any>(
    `SELECT position, company, months, description, location, start_date, end_date, is_current, bullets
       FROM work_experience WHERE resume_id=? ORDER BY sort_order, experience_id`,
    [id],
  );
  const experience = exp.map((e) => ({
    position: e.position, company: e.company, months: Number(e.months), description: e.description,
    ...(e.location ? { location: e.location } : {}),
    ...(e.start_date ? { startDate: e.start_date } : {}),
    ...(e.end_date ? { endDate: e.end_date } : {}),
    ...(Number(e.is_current) ? { current: true } : {}),
    // Stored newline-separated; empty lines dropped so a stray blank line
    // cannot render as an empty bullet.
    ...(e.bullets ? { bullets: String(e.bullets).split('\n').map((b: string) => b.trim()).filter(Boolean) } : {}),
  }));

  const sk = pre ? (pre.skills.get(id) ?? []) : await query<{ skill_name: string; added_at: any; evidence_kind: string | null; evidence_ref: string | null }>(
    `SELECT s.skill_name, rs.added_at, rs.evidence_kind, rs.evidence_ref FROM resume_skills rs
       JOIN skills s ON s.skill_id = rs.skill_id
      WHERE rs.resume_id = ? ORDER BY s.skill_name`,
    [id],
  );
  const skills = sk.map((r2) => r2.skill_name);
  /* Kept beside the flat list rather than folded into it, so nothing that
     scores or matches has to know this exists. Only the recruiter's applicant
     view reads it. */
  const skillsAddedAt: Record<string, number> = {};
  for (const r2 of sk) if (r2.added_at) skillsAddedAt[r2.skill_name] = ts(r2.added_at);

  /* WHERE EACH SKILL WAS USED. The engine reads an empty object as "asked,
     no sources given" (partial credit) and an absent one as "never asked"
     (full credit), so the key is emitted whenever the applicant HAS been
     asked — even if they linked nothing, since dropping it then would hand
     back the credit this feature exists to withhold — and omitted when they
     have not, which is the case for a resume imported from an uploaded CV.
     resumes.evidence_prompted is what separates the two; see the emit below.
     Skills with no source simply have no entry.

     This never reaches the printed sheet. resume-print renders `skills`, a
     flat list of strings, and has no idea this map exists. */
  const skillEvidence: Record<string, { kind: string; ref: string }> = {};
  for (const r2 of sk) {
    if (r2.evidence_kind && r2.evidence_ref) {
      skillEvidence[r2.skill_name] = { kind: r2.evidence_kind, ref: r2.evidence_ref };
    }
  }

  const ce = pre ? (pre.certifications.get(id) ?? []) : await query<any>(
    `SELECT cert_name, year_taken, issuer, credential_id
       FROM certifications WHERE resume_id=? ORDER BY sort_order, certification_id`,
    [id],
  );
  const certifications = ce.map((c) => ({
    name: c.cert_name, year: c.year_taken,
    ...(c.issuer ? { issuer: c.issuer } : {}),
    ...(c.credential_id ? { credentialId: c.credential_id } : {}),
  }));

  /* Optional sections. Emitted only when they hold something, so an empty
     section never reaches the sheet as a bare heading. */
  const pj = pre ? (pre.projects.get(id) ?? []) : await query<any>(
    `SELECT proj_name, proj_role, start_date, end_date, description, link
       FROM projects WHERE resume_id=? ORDER BY sort_order, project_id`, [id]);
  const projects = pj.map((x) => ({
    name: x.proj_name,
    ...(x.proj_role ? { role: x.proj_role } : {}),
    ...(x.start_date ? { startDate: x.start_date } : {}),
    ...(x.end_date ? { endDate: x.end_date } : {}),
    ...(x.description ? { description: x.description } : {}),
    ...(x.link ? { link: x.link } : {}),
  }));

  const lg = pre ? (pre.languages.get(id) ?? []) : await query<any>(
    `SELECT lang_name, proficiency FROM resume_languages
      WHERE resume_id=? ORDER BY sort_order, language_id`, [id]);
  const languages = lg.map((x) => ({
    name: x.lang_name, ...(x.proficiency ? { proficiency: x.proficiency } : {}),
  }));

  const rf = pre ? (pre.references.get(id) ?? []) : await query<any>(
    `SELECT ref_name, position, company, email, phone FROM resume_references
      WHERE resume_id=? ORDER BY sort_order, reference_id`, [id]);
  const references = rf.map((x) => ({
    name: x.ref_name,
    ...(x.position ? { position: x.position } : {}),
    ...(x.company ? { company: x.company } : {}),
    ...(x.email ? { email: x.email } : {}),
    ...(x.phone ? { phone: x.phone } : {}),
  }));

  // The uploaded file: metadata only. The bytes are served by /api/file,
  // which checks who is asking. There is no public URL to this document.
  /* The uploaded file: metadata, plus what was read out of it.
     `extract` is the structured resume the engine scores; `extractStatus`
     says why it is absent when it is. Those two must stay distinguishable —
     "we could not read this document" and "this document scored zero" mean
     opposite things to the person reading the ranking. */
  const ownFile = r.own_file_name
    ? {
        name: r.own_file_name,
        mime: r.own_file_mime,
        size: Number(r.own_file_size),
        uploadedAt: ts(r.own_file_uploaded_at),
        ...((r as any).own_file_extract_status
          ? { extractStatus: (r as any).own_file_extract_status }
          : {}),
        ...((r as any).own_file_extract
          ? { extract: typeof (r as any).own_file_extract === 'string'
              ? JSON.parse((r as any).own_file_extract)
              : (r as any).own_file_extract }
          : {}),
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
      ...((r as any).headline ? { headline: (r as any).headline } : {}),
      ...((r as any).linkedin ? { linkedin: (r as any).linkedin } : {}),
      ...((r as any).portfolio ? { portfolio: (r as any).portfolio } : {}),
    },
    education, experience, skills, certifications, ownFile,
    ...(Object.keys(skillsAddedAt).length ? { skillsAddedAt } : {}),
    /* Emitted only once the applicant has actually been ASKED. The builder
       asks and so sets resumes.evidence_prompted; an import from an uploaded
       CV never does. Omitting the key is what tells the engine "never asked",
       and it is the difference between a CV scoring 80 and the same CV
       scoring 65 for declining a question it was never shown. */
    ...(r.evidence_prompted ? { skillEvidence } : {}),
    // Only present when non-empty — an empty array would still be truthy in
    // a template and could render a heading with nothing under it.
    ...(projects.length ? { projects } : {}),
    ...(languages.length ? { languages } : {}),
    ...(references.length ? { references } : {}),
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
  const ct = await query<{ cert_name: string }>(
    'SELECT cert_name FROM posting_certifications WHERE posting_id=? ORDER BY cert_name',
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
    /* WHOLE PERCENTAGES, the same units the column stores and the recruiter
       types — so "must total 100" is an exact integer check rather than a
       float comparison with a tolerance. The engine divides by 100 at the one
       point it multiplies. null means the opening never set any and inherits
       the site defaults, which is not the same as a copy of them: the
       researcher can retune those and every uncustomised opening follows. */
    weights: p.weight_skills == null ? null : {
      skills: Number(p.weight_skills),
      education: Number(p.weight_education),
      experience: Number(p.weight_experience),
      /* NULL means 0 rather than "unset". An opening written before this
         component existed carries three weights totalling 100, and reporting
         its fourth as null would make the published breakdown fail to add up
         to the score printed beside it. */
      certifications: p.weight_certifications == null ? 0 : Number(p.weight_certifications),
    },
    certifications: ct.map((r) => r.cert_name),
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
