/* ============================================================
   ResumeMatch PH — shared TypeScript models
   ------------------------------------------------------------
   The JSON shapes here are exactly what the Node API (and the
   demo/localStorage adapter) return, mirroring the original
   assets/api.js / api/_lib.php contract 1:1.
   ============================================================ */

export type Role = 'seeker' | 'recruiter' | 'admin';

/** A pending/handled request for recruiter access, reviewed at /admin. */
export interface RecruiterRequest {
  id: string;
  name: string;
  email: string;
  position: string;
  companyId: string | null;
  companyName: string;
  note: string;
  status: 'pending' | 'approved' | 'declined';
  requestedAt: number;
}

/** A recruiter account as listed on the admin panel. */
export interface AdminRecruiter {
  id: string;
  name: string;
  email: string;
  position: string;
  companyName: string;
  verified: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

/** Department routing: which HR person owns each of a company's departments.
 *  An owned department emails only its owner on a new application; an
 *  unassigned one falls back to notifying every verified recruiter. */
export interface DeptAssignment {
  department: string;
  userId: string;
  userName: string;
}
export interface RoutingCompany {
  id: string;
  name: string;
  departments: string[];
  recruiters: { id: string; name: string }[];
  assignments: DeptAssignment[];
}
export type EduLevel = 'none' | 'highschool' | 'vocational' | 'associate' | 'bachelor' | 'master';
export type Template = 'chronological' | 'functional' | 'combination';
/** Visual style of the rendered/printed resume. Every design is single-column
 *  and ATS-safe: real headings, real text, no tables, no graphics.
 *
 *  Section ORDER normally stays with Template — a design only skins the sheet.
 *  The two exceptions are 'graduate' and 'technical', which exist *because* of
 *  the order they impose (education first for a fresh graduate; skills and
 *  projects first for a technical applicant). Picking one of those overrides
 *  the Template order, and the builder says so on screen rather than leaving
 *  the Template radio looking as though it still applies. */
export type ResumeDesign =
  | 'classic' | 'modern' | 'minimal' | 'executive' | 'banner' | 'split' | 'bar' | 'categorized'
  | 'traditional' | 'clean' | 'compact' | 'senior' | 'graduate' | 'technical';
export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'internship';
export type AppStatus = 'submitted' | 'review' | 'shortlisted' | 'rejected' | 'hired' | 'withdrawn';
export type Tier = 'strong' | 'possible' | 'related';

export interface User {
  id: string;
  role: Role;
  name: string;
  email: string;
  createdAt: number;
  /** Application-event emails (status changes / new applicants). Absent = on. */
  emailNotifications?: boolean;
  // seeker
  activeResumeId?: string | null;
  // recruiter
  companyId?: string | null;
  position?: string | null;
  verified?: boolean;
}

export interface Company {
  id: string;
  name: string;
  industry: string | null;
  location: string | null;
  about: string | null;
  website: string | null;
}

/* ---------------------------------------------------------------------
   THE RESUME RECORD

   Everything added below is OPTIONAL and additive. Three fields are load-
   bearing and deliberately untouched, because the matching engine scores
   on exactly these and nothing else:

     · skills          a FLAT string[] — normalised and set-matched
     · education.level feeds EDU_RANK for the education component
     · experience.months summed for the experience component

   Richer alternatives were considered (grouped skills, start/end dates in
   place of months, dropping level in favour of free-text degree) and
   rejected: they would have required rewriting the engine, its demo-mode
   twin, the parity suite, and the 50/25/25 formula published in the study.
   A resume can now carry far more, and the score still comes from the same
   three inputs it always did.
   --------------------------------------------------------------------- */

export interface Personal {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  summary: string;
  /** One line under the name — "BS Information Technology graduate". */
  headline?: string;
  /** Printed as the full visible URL, never a bare anchor label: parsers
   *  routinely drop href, so a link that only reads "LinkedIn" is lost. */
  linkedin?: string;
  portfolio?: string;
}

export interface Education {
  school: string;
  degree: string;
  /** SCORED. Keep. */
  level: EduLevel;
  year: string;
  /** Field of study, where the degree name alone doesn't carry it. */
  field?: string;
  location?: string;
  honors?: string;
}

export interface Experience {
  position: string;
  company: string;
  /** SCORED. Keep — the engine sums these. Dates below are for display. */
  months: number;
  description: string;
  location?: string;
  /** Free text ("Jun 2025"), shown on the sheet. Never parsed for scoring. */
  startDate?: string;
  endDate?: string;
  current?: boolean;
  /** Achievement bullets. `description` stays as the prose fallback so
   *  every existing resume keeps rendering exactly as before. */
  bullets?: string[];
}

export interface Certification {
  name: string;
  year: string;
  issuer?: string;
  credentialId?: string;
}

/** Optional sections. Absent or empty means the heading is not rendered at
 *  all — no empty heading, no leftover gap. */
export interface Project {
  name: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  link?: string;
}

export interface Language {
  name: string;
  /** Text only. Never a bar, star rating or percentage — a graphic carries
   *  no meaning through a parser and none through greyscale print. */
  proficiency?: string;
}

export interface Reference {
  name: string;
  position?: string;
  company?: string;
  email?: string;
  phone?: string;
}

/** Why the applicant's own document has no reading attached to it.
 *   · ok          — it was read; `extract` holds the result
 *   · unavailable — automatic reading isn't set up (no API key, or demo mode)
 *   · unreadable  — the format can't be read at all (old .doc, odd type)
 *   · failed      — it was attempted and didn't work: network, quota, or a
 *                   scan whose text isn't legible to software
 *
 *  Anything other than 'ok' means NO SCORE — which is not the same as a score
 *  of zero, and must never be shown as one. */
export type ExtractStatus = 'ok' | 'unavailable' | 'unreadable' | 'failed';

export interface OwnFile {
  name: string;
  mime: string;
  size: number;
  uploadedAt: number;
  dataUrl?: string; // demo mode only — the file itself, base64
  /** The document read into the same structured shape the builder edits, so
   *  the engine can score it. Absent unless `extractStatus` is 'ok'. */
  extract?: AnalyzedResume;
  extractStatus?: ExtractStatus;
}

export interface Resume {
  id: string | null;
  userId?: string;
  title: string;
  template: Template;
  design: ResumeDesign;
  personal: Personal;
  education: Education[];
  experience: Experience[];
  /** Optional sections. Absent or empty renders nothing at all — no
   *  heading, no gap. Optional so every resume saved before they existed
   *  stays valid without a migration on the client side. */
  projects?: Project[];
  languages?: Language[];
  references?: Reference[];
  skills: string[];
  certifications: Certification[];
  ownFile: OwnFile | null;
  updatedAt?: number;
}

export interface Posting {
  id: string;
  companyId: string;
  title: string;
  department: string;
  employmentType: EmploymentType;
  description: string;
  skills: string[];
  educationLevel: EduLevel;
  minExperienceMonths: number;
  /** Optional "apply by" date (YYYY-MM-DD). Past it, the posting stops
   *  accepting applications without anyone closing it by hand. */
  deadline?: string | null;
  expired?: boolean;
  /** This opening's own scoring weights as WHOLE PERCENTAGES totalling 100,
   *  or null when it inherits the site defaults. Percentages rather than
   *  fractions all the way to the database, so "must total 100" is an exact
   *  integer check; the engine divides by 100 where it multiplies. */
  weights?: { skills: number; education: number; experience: number } | null;
  status: 'open' | 'closed';
  createdAt: number;
  company?: Company;
  applicantCount?: number;
  newCount?: number;
}

export interface Application {
  id: string;
  seekerId: string;
  resumeId: string;
  postingId: string;
  status: AppStatus;
  appliedAt: number;
  /** The match score at the MOMENT of applying (the server's
   *  applications.score_snapshot). Frozen deliberately: a résumé and a
   *  posting can both change afterwards, and the study needs to report the
   *  number the applicant actually saw, not one recomputed later. */
  scoreSnapshot?: number | null;
  updatedAt?: number;
  posting?: Posting | null;
  company?: Company | null;
  resumeTitle?: string | null;
}

/** One recorded change of an application's status.
 *
 *  These rows have always been written (inside the same transaction as the
 *  change itself, so a decision can never exist without a record of it) but
 *  were previously readable only by the researcher metrics page. `by` is a
 *  ROLE, never a person: the applicant is told what was decided and when,
 *  which is what affects them, without naming the individual HR staff member
 *  who did it. */
/** Why a recruiter moved an application. A closed list so outcomes can be
 *  counted, mirrored as a runtime constant in core/engine.ts and again in
 *  server/src/lib/engine.ts. */
export type RejectionReason =
  | 'not_qualified' | 'failed_requirement' | 'salary_mismatch' | 'unreachable'
  | 'position_filled' | 'stronger_candidate' | 'withdrew_interest' | 'other';

export interface StatusEvent {
  /** null for the first event — applying has no previous status. */
  from: AppStatus | null;
  to: AppStatus;
  at: number;
  by: 'applicant' | 'employer';
  /** The individual who made the change, present ONLY when the caller is
   *  staff at the company that owns the posting. Absent for the applicant,
   *  by design: internal accountability is why changed_by is stored, but
   *  naming an HR staff member to an applicant is a different disclosure.
   *  Treat `undefined` as "not disclosed", never as "unknown actor". */
  byName?: string;
  /** Why the change was made, as one of REJECTION_REASONS. Present on the
   *  same terms as `byName`: employer staff only, never the applicant. A
   *  reason the subject will read is a reason nobody records candidly. */
  reason?: RejectionReason;
}

/** A recruiter's working note on one application — "called 3pm, no answer".
 *  INTERNAL: no route returns these to the applicant. */
export interface ScreeningNote {
  id: string;
  body: string;
  at: number;
  authorName: string;
  /** True when the signed-in recruiter wrote it. Only the author may delete. */
  mine: boolean;
}

export interface MatchResult {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  totalSkills: number;
  eduMeets: boolean;
  expMeets: boolean;
  seekerMonths: number;
  tier: Tier;
  /** The weights this score was computed with, as fractions. Carried on the
   *  result so a breakdown always adds up to the number beside it — see the
   *  same field in server/src/lib/engine.ts. */
  weights: { skills: number; education: number; experience: number };
}

export interface RecommendationItem extends MatchResult {
  posting: Posting;
  company: Company | null;
  applied: boolean;
  /** The same posting scored against the applicant's own uploaded document.
   *  Absent when there is no readable document — never zero in that case. */
  fileScore?: MatchResult;
}

export interface RankedRow extends MatchResult {
  application: Application;
  resume: Resume;
  seeker: { id: string; name: string; email: string; role: 'seeker' };
  /** The applicant's own document, scored. Shown beside the ranking number
   *  but never used FOR the ranking: a misread scan must not move a person
   *  down the list. */
  fileScore?: MatchResult;

  /* `score` and `tier` above are the values RECORDED WHEN THE APPLICATION WAS
     MADE, because a shortlist that reorders itself between two visits is not a
     record of a decision. The three fields below describe the resume as it
     stands today, so an applicant who improved it is visible as a labelled
     change rather than a silent move up the list. */

  /** What this resume would score against this posting right now. */
  liveScore?: number;
  liveTier?: Tier;
  /** True when the resume has changed since the application was submitted. */
  scoreDrifted?: boolean;

  /** Required skills first claimed on the day this application was made.
   *  Context for an interview question and nothing else — it does not affect
   *  the score, the tier, the ordering, or whether the applicant is shown. */
  skillsClaimedOnApplyDay?: string[];
}

export interface HrStats {
  openPostings: number;
  totalPostings: number;
  totalApplicants: number;
  needsReview: number;
  byStatus: Record<AppStatus, number>;
}

/** What the AI analysis of an uploaded resume returns: the same structured
 *  shape the builder edits, minus ids/files. Nothing is saved until the
 *  user reviews it in the builder and saves like any hand-built resume. */
export interface AnalyzedResume {
  title: string;
  template: Template;
  design?: ResumeDesign;
  personal: Personal;
  education: Education[];
  experience: Experience[];
  skills: string[];
  certifications: Certification[];
  projects?: Project[];
  languages?: Language[];
  references?: Reference[];
}

/** Every API method returns this shape — success carries the payload,
 *  failure carries a human-readable message. Never throws. */
export type ApiResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; exists?: boolean };
