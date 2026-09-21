/* ============================================================
   Linaw PH, shared TypeScript models
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
export type EduLevel = 'none' | 'highschool' | 'vocational' | 'associate' | 'college_level' | 'bachelor' | 'master';
export type Template = 'chronological' | 'functional' | 'combination';
/** Visual style of the rendered/printed resume. Every design is single-column
 *  and ATS-safe: real headings, real text, no tables, no graphics.
 *
 *  Section ORDER normally stays with Template, a design only skins the sheet.
 *  The two exceptions are 'graduate' and 'technical', which exist *because* of
 *  the order they impose (education first for a fresh graduate; skills and
 *  projects first for a technical applicant). Picking one of those overrides
 *  the Template order, and the builder says so on screen rather than leaving
 *  the Template radio looking as though it still applies. */
export type ResumeDesign =
  | 'classic' | 'modern' | 'minimal' | 'executive' | 'banner' | 'split' | 'bar' | 'rail'
  | 'traditional' | 'clean' | 'compact' | 'senior' | 'graduate' | 'technical';
export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'internship';
/* The application pipeline, aligned to the partner's own eight stages
   (Clark Outsourcing information request, section 6). The recruiter-settable
   pipeline is: submitted (their "Applied") → scheduling → initial_interview →
   testing → shortlisted → final_interview → offer → hired (their "New employee
   onboarding"), with 'rejected' as the off-ramp and 'withdrawn' as the
   applicant's own exit. 'review' is retained only so rows written before the
   pipeline was expanded still render and count — it is no longer offered in
   the picker. */
export type AppStatus =
  | 'submitted' | 'scheduling' | 'initial_interview' | 'testing' | 'shortlisted'
  | 'final_interview' | 'offer' | 'hired' | 'rejected' | 'withdrawn'
  | 'review';
export type Tier = 'strong' | 'possible' | 'related';

export interface User {
  id: string;
  role: Role;
  /** The two parts registration asks for, and the only ones stored. */
  firstName: string;
  lastName: string;
  /** first + last, derived by the database. Read-only: the two fields above
   *  are what a change writes to. Kept because most of the site wants a
   *  person's name as one string and should not have to assemble it. */
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

     · skills          a FLAT string[], normalised and set-matched
     · education.level feeds EDU_RANK for the education component
     · experience.months summed for the experience component

   Richer alternatives were considered (grouped skills, start/end dates in
   place of months, dropping level in favour of free-text degree) and
   rejected: they would have required rewriting the engine, its demo-mode
   twin, the parity suite, and the default 50/25/25 split.
   A resume can now carry far more, and the score still comes from the same
   three inputs it always did.
   --------------------------------------------------------------------- */

export interface Personal {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  summary: string;
  /** One line under the name, "BS Information Technology graduate". */
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
  /** SCORED. Keep. The engine sums these. Dates below are for display. */
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
 *  all, no empty heading, no leftover gap. */
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
  /** Text only. Never a bar, star rating or percentage, a graphic carries
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
 *   · ok         , it was read; `extract` holds the result
 *   · unavailable, automatic reading isn't set up (no API key, or demo mode)
 *   · unreadable . The format can't be read at all (old .doc, odd type)
 *   · failed     . It was attempted and didn't work: network, quota, or a
 *                   scan whose text isn't legible to software
 *
 *  Anything other than 'ok' means NO SCORE: which is not the same as a score
 *  of zero, and must never be shown as one. */
export type ExtractStatus = 'ok' | 'unavailable' | 'unreadable' | 'failed';

export interface OwnFile {
  name: string;
  mime: string;
  size: number;
  uploadedAt: number;
  dataUrl?: string; // demo mode only, the file itself, base64
  /** The document read into the same structured shape the builder edits, so
   *  the engine can score it. Absent unless `extractStatus` is 'ok'.
   *
   *  PARTIAL, and deliberately so. This arrives as JSON out of a database
   *  column and is handed straight to the client without being re-validated
   *  at the boundary (serializers.ts parses it and passes it through), so
   *  the full shape is a claim about the row rather than something the type
   *  system has checked. A row written by an earlier version of the reader,
   *  or by hand, need not carry every field. Declaring it complete made the
   *  compiler call the template's null-guards redundant and suggest removing
   *  them, which would have turned one malformed row into a crash on the
   *  recruiter's applicant panel. */
  extract?: Partial<AnalyzedResume>;
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
  /** Optional sections. Absent or empty renders nothing at all, no
   *  heading, no gap. Optional so every resume saved before they existed
   *  stays valid without a migration on the client side. */
  projects?: Project[];
  languages?: Language[];
  references?: Reference[];
  skills: string[];
  /** Where each skill was used, keyed by the skill exactly as it appears in
   *  `skills`. Optional, and an absent key is not an error: it means the
   *  applicant named no source for that skill, which is allowed and costs
   *  partial credit rather than the whole match. NEVER rendered by the print
   *  sheet or any of the fourteen designs. */
  /** Each skill maps to a LIST of sources — a skill can be learned in more
   *  than one place. Older resumes stored a single object; readers normalise
   *  both via evidenceSources(). */
  skillEvidence?: Record<string, SkillEvidence | SkillEvidence[]>;
  certifications: Certification[];
  /** Portfolio and certificate URLs for the RECRUITER, never for the page.
   *  Deliberately not part of `personal`, which is what the fourteen designs
   *  render: a link here reaches the person screening the application and
   *  never touches the document, so a long URL cannot disturb the
   *  parser-safe layout the designs exist to protect. */
  links?: ResumeLink[];
  /** Sections the applicant switched off. A hidden section is omitted from
   *  the document AND from scoring, because both should describe what the
   *  applicant actually chose to present. Absent means nothing is hidden,
   *  which is what every resume saved before this existed carries. */
  hiddenSections?: ResumeSection[];
  ownFile: OwnFile | null;
  updatedAt?: number;
}

/** A link the recruiter sees and the printed resume never carries. */
export interface ResumeLink {
  id?: string;
  /** What the applicant calls it — "Portfolio", "AWS certificate". Optional;
   *  the URL alone is shown when it is blank. */
  label?: string;
  url: string;
}

/** The sections an applicant may switch off. `education`, `experience` and
 *  `skills` are absent on purpose: they are the three the score is always
 *  built from, and a resume that presents none of them is not a resume. */
export type ResumeSection =
  | 'summary' | 'projects' | 'certifications' | 'languages' | 'references' | 'links';

/** One question a recruiter attached to an opening. */
export interface PostingQuestion {
  id?: string;
  prompt: string;
}

/** One applicant's answer to one of those questions. */
export interface ApplicationAnswer {
  questionId: string;
  prompt?: string;
  answer: string;
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
  weights?: {
    skills: number; education: number; experience: number;
    certifications?: number; projects?: number; languages?: number; references?: number;
  } | null;
  /** Certifications this opening asks for, free text. Scored only when the
   *  recruiter gives the certifications weight a share; absent or empty means
   *  full marks on that component, as an unstated requirement always does. */
  certifications?: string[];
  /** Languages this opening asks for, matched the same way certifications are. */
  languages?: string[];
  /** Minimum counts for the two sections scored the way experience is. 0 or
   *  absent states no requirement, which scores full marks. */
  minProjects?: number;
  minReferences?: number;
  /** Questions the applicant must answer to apply. Never scored — they exist
   *  so a recruiter can ask the one or two things a resume never says. */
  questions?: PostingQuestion[];
  status: 'open' | 'closed';
  createdAt: number;
  company?: Company;
  applicantCount?: number;
  newCount?: number;
  /** The colleague this opening's applications route to, from the company's
   *  department assignments. Null when the department has no owner, which is
   *  filterable in its own right — an unowned department is worth finding. */
  ownerId?: string | null;
  ownerName?: string | null;
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
  /** What this applicant wrote to the opening's screening questions, in the
   *  order the recruiter asked them. Never scored — free text a person reads.
   *  Absent when the opening asked nothing. */
  answers?: ApplicationAnswer[];
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
  /** null for the first event, applying has no previous status. */
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
  /** Why the change was made, as one of REJECTION_REASONS.
   *
   *  Shown to BOTH audiences, unlike `byName` directly above, which stays
   *  employer-only. The applicant learns what was decided; they do not learn
   *  which member of staff decided it. The wording differs by audience:
   *  REASON_LABELS is what the recruiter files under, APPLICANT_REASON_LABELS
   *  is the same fact addressed to the person it is about. */
  reason?: RejectionReason;
}

/** An optional interview time a recruiter attaches to an invite. `startIso`
 *  is an absolute instant (a datetime-local field converted to ISO), so the
 *  applicant's calendar shows it in their own timezone. Turned into an
 *  "Add to Google Calendar" link and an .ics attachment in the email. */
export interface InviteSchedule {
  startIso: string;
  durationMinutes?: number;
  location?: string;
}

/* ------------------------------------------------------------
   EVIDENCE-LINKED SKILLS, mirrored from server/src/lib/engine.ts, where the
   reasoning is written out in full. In short: the builder asks where each
   skill was used and the answer must point at an entry already on the
   applicant's own resume. A skill with a source counts in full; one without
   still counts, at partial credit. The link is never printed on the resume, the downloaded document is unchanged, and is shown only in the
   recruiter's applicant view.
   ------------------------------------------------------------ */
export type EvidenceKind = 'experience' | 'project' | 'certification' | 'education' | 'document';

export interface SkillEvidence {
  kind: EvidenceKind;
  /** The label of the entry it points at, as the applicant wrote it —
   *  "Web Development Intern, Clark Outsourcing". */
  ref: string;
}

/** A recruiter's working note on one application, "called 3pm, no answer".
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
  /** Matched skills the applicant named no source for. Each still counts,
   *  at UNEVIDENCED_CREDIT rather than in full, see engine.ts. Empty when
   *  evidence does not apply (the uploaded-document score, which was never
   *  asked the question). */
  unevidencedMatches: string[];
  totalSkills: number;
  eduMeets: boolean;
  expMeets: boolean;
  seekerMonths: number;
  tier: Tier;
  /** The weights this score was computed with, as fractions. Carried on the
   *  result so a breakdown always adds up to the number beside it, see the
   *  same field in server/src/lib/engine.ts. */
  weights: {
    skills: number; education: number; experience: number;
    certifications: number; projects: number; languages: number; references: number;
    /** The optional relevant-experience share. Zero unless a recruiter set it. */
    relevance: number;
  };
  /** Months of experience that came from a job whose own title, description
   *  or bullets mention a skill this opening asks for. Reported beside
   *  seekerMonths so a recruiter can see the total and the relevant part
   *  separately, whether or not the component carries any weight. */
  relevantMonths: number;
  /** Of the certifications the opening asked for, the ones the applicant
   *  lists and the ones they do not. Both empty when none were asked for. */
  matchedCertifications: string[];
  missingCertifications: string[];
  /** The same pair for languages, matched the same way. */
  matchedLanguages: string[];
  missingLanguages: string[];
  /** Counts beside the minimum the opening asked for. A minimum of 0 means
   *  none was stated, which the score treats as met in full. */
  projectCount: number;
  minProjects: number;
  referenceCount: number;
  minReferences: number;
}

export interface RecommendationItem extends MatchResult {
  posting: Posting;
  company: Company | null;
  applied: boolean;
  /** The same posting scored against the applicant's own uploaded document.
   *  Absent when there is no readable document, never zero in that case. */
  fileScore?: MatchResult;
}

/** What the recruiter's applicant list asks for: which slice, and filtered
 *  how. Filtering is server-side because the list is paged — narrowing a
 *  single page would hide matching applicants sitting on another. */
export interface RankedQuery {
  page?: number;
  /** 0 or absent means every matching row, which is what export and print need. */
  pageSize?: number;
  q?: string;
  status?: string;
  tier?: string;
  file?: '' | 'yes' | 'no';
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
   *  Context for an interview question and nothing else, it does not affect
   *  the score, the tier, the ordering, or whether the applicant is shown. */
  skillsClaimedOnApplyDay?: string[];

  /** What this applicant wrote to the opening's screening questions, in the
   *  order the recruiter asked them. Never scored. Absent when the opening
   *  asked nothing, which is every opening that has not added a question. */
  answers?: ApplicationAnswer[];

  /** True when the resume row itself has gone but the application has not.
   *  The row still appears — an application that was received must never
   *  vanish from the list — with the score recorded when it was made. */
  resumeUnavailable?: boolean;
}

export interface HrStats {
  openPostings: number;
  totalPostings: number;
  totalApplicants: number;
  needsReview: number;
  byStatus: Record<AppStatus, number>;
}

/** What the recruiter dashboard can narrow its counters by. All optional:
 *  an empty object is the whole company, which is what the page opens on.
 *  Dates are plain YYYY-MM-DD and read as inclusive of both endpoints. */
export interface HrStatsFilters {
  postingId?: string;
  staffId?: string;
  department?: string;
  applicant?: string;
  from?: string;
  to?: string;
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

/** Every API method returns this shape, success carries the payload,
 *  failure carries a human-readable message. Never throws. */
export type ApiResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; exists?: boolean };
