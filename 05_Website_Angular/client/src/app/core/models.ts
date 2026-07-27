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
/** Visual style of the rendered/printed resume. Section ORDER stays with
 *  Template; this only skins the sheet. Every design is single-column and
 *  ATS-safe. */
export type ResumeDesign = 'classic' | 'modern' | 'minimal' | 'executive' | 'banner' | 'split' | 'bar' | 'categorized';
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

export interface Personal {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  summary: string;
}

export interface Education {
  school: string;
  degree: string;
  level: EduLevel;
  year: string;
}

export interface Experience {
  position: string;
  company: string;
  months: number;
  description: string;
}

export interface Certification {
  name: string;
  year: string;
}

export interface OwnFile {
  name: string;
  mime: string;
  size: number;
  uploadedAt: number;
  dataUrl?: string; // demo mode only — the file itself, base64
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

export interface MatchResult {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  totalSkills: number;
  eduMeets: boolean;
  expMeets: boolean;
  seekerMonths: number;
  tier: Tier;
}

export interface RecommendationItem extends MatchResult {
  posting: Posting;
  company: Company | null;
  applied: boolean;
}

export interface RankedRow extends MatchResult {
  application: Application;
  resume: Resume;
  seeker: { id: string; name: string; email: string; role: 'seeker' };
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
}

/** Every API method returns this shape — success carries the payload,
 *  failure carries a human-readable message. Never throws. */
export type ApiResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; exists?: boolean };
