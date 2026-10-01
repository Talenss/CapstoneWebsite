/* ============================================================
   Matching engine + shared constants, ported 1:1 from
   the PHP api.js (score(), WEIGHTS, THRESHOLDS, …)
   Used by demo mode directly, and by the builder/browse/hr-posting
   pages for instant client-side "how would this score" previews
   in BOTH modes (the API mode still calls the server for anything
   that must be authoritative, e.g. applying).
   ============================================================ */
import { AppStatus, EduLevel, EvidenceKind, MatchResult, Posting, RejectionReason, Resume, SkillEvidence, Tier } from './models';

/* The study's published defaults. The SERVER is the authority, it reads
   these from the match_settings table, so an admin can retune them without a
   redeploy. These objects are MUTATED (never reassigned) by applyMatchSettings()
   at startup in api mode, so every call site below keeps working while the
   live score a seeker sees stays equal to the score the server stores.
   Without that, editing match_settings would show the seeker one number and
   the recruiter another for the very same application. */
/** Four of the seven components are optional and sit at 0, so the site-wide
 *  split stays the study's published 50/25/25 across the compulsory three
 *  unless a recruiter gives one of the others a share on their own opening. */
export const WEIGHTS = {
  skills: 0.5, education: 0.25, experience: 0.25,
  certifications: 0, projects: 0, languages: 0, references: 0, relevance: 0, field: 0,
};
export const THRESHOLDS = { strong: 80, related: 50 };

/** The optional components, in interface order. The browser's mirror of
 *  OPTIONAL_WEIGHTS in server/src/lib/engine.ts and it must stay identical:
 *  the two validators have to reject and accept exactly the same weight sets,
 *  or a posting the recruiter could save would score differently in the
 *  seeker's live preview than on the server. */
export const OPTIONAL_WEIGHTS = ['certifications', 'projects', 'languages', 'references', 'relevance', 'field'] as const;
/** The three a recruiter may de-emphasise but never switch off. */
export const CORE_WEIGHTS = ['skills', 'education', 'experience'] as const;
/** No compulsory component may fall below this share. */
export const WEIGHT_FLOOR = 10;
/** Weight controls move in whole steps of this size. A recruiter setting a
 *  balance by hand is expressing a rough priority, not a calibrated ratio,
 *  and offering single points invites a precision the judgement does not
 *  carry — 45/30/25 is a decision, 47/28/25 is a slip of the mouse. */
export const WEIGHT_STEP = 5;

/** Every accepted value of `resumes.design`. Anything else falls back to
 *  'classic' rather than being rejected, so a resume saved by a newer build
 *  still opens on an older one. Three places must agree with this list: the
 *  ResumeDesign union in models.ts, the whitelist in server routes/resumes.ts,
 *  and the CHECK constraint on the resumes table. */
export const DESIGNS: string[] = [
  'classic', 'modern', 'minimal', 'executive', 'banner', 'split', 'bar', 'rail',
  'traditional', 'clean', 'compact', 'senior', 'graduate', 'technical',
];

/** Two designs are defined by the ORDER they impose, not by their looks, so
 *  they override the template's order. Everything else leaves it alone. */
export const DESIGN_ORDER: Record<string, ('education' | 'experience' | 'skills' | 'projects' | 'certifications')[]> = {
  graduate: ['education', 'projects', 'certifications', 'experience', 'skills'],
  technical: ['skills', 'projects', 'experience', 'education', 'certifications'],
};

/** Adopt the server's weights and thresholds. Ignores anything malformed, so
 *  a bad row in match_settings degrades to the published defaults rather than
 *  producing NaN scores across the whole interface. */
export function applyMatchSettings(s: {
  weights?: Partial<typeof WEIGHTS>;
  thresholds?: Partial<typeof THRESHOLDS>;
} | null | undefined): void {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  const w = s?.weights;
  if (w) {
    const sk = num(w.skills), ed = num(w.education), ex = num(w.experience);
    // All three or none. A partial set would silently change the total scale.
    // The optional four are separate: absent means 0, the value they hold.
    if (sk !== null && ed !== null && ex !== null && sk >= 0 && ed >= 0 && ex >= 0) {
      WEIGHTS.skills = sk; WEIGHTS.education = ed; WEIGHTS.experience = ex;
      for (const k of OPTIONAL_WEIGHTS) {
        const v = num((w as Record<string, unknown>)[k]);
        WEIGHTS[k] = v !== null && v >= 0 ? v : 0;
      }
    }
  }
  const th = s?.thresholds;
  if (th) {
    const st = num(th.strong), rl = num(th.related);
    if (st !== null && rl !== null && st > rl && rl >= 0 && st <= 100) {
      THRESHOLDS.strong = st; THRESHOLDS.related = rl;
    }
  }
}

/* Mirrored 1:1 from server/src/lib/engine.ts. A closed list, so the outcome of
   a shortlist can be counted rather than read, and so a recruiter in a hurry
   cannot write something the company would not want to stand behind. */
export const REJECTION_REASONS: RejectionReason[] = [
  'not_qualified', 'failed_requirement', 'salary_mismatch', 'unreachable',
  'position_filled', 'stronger_candidate', 'withdrew_interest', 'other',
];

/** What the recruiter picks from. Wording is deliberately factual, these are
 *  read back months later by someone reconstructing a decision. */
export const REASON_LABELS: Record<RejectionReason, string> = {
  not_qualified:      'Did not meet the requirements',
  failed_requirement: 'Missing a required credential or licence',
  salary_mismatch:    'Salary expectations did not match',
  unreachable:        'Could not be contacted',
  position_filled:    'Position filled',
  stronger_candidate: 'Another candidate was a closer fit',
  withdrew_interest:  'Withdrew interest',
  other:              'Other',
};

/** The SAME codes, written for the person they are about.
 *
 *  Not a euphemism of the recruiter's wording, the same fact, in the second
 *  person, because an applicant reading "Another candidate was a closer fit"
 *  about themselves is reading a file note, and one reading "The role went to
 *  another candidate" is being told what happened to them. Where the honest
 *  answer is actionable it says so, since the whole reason this reaches the
 *  applicant at all is that "unreachable" is a thing a person can fix.
 *
 *  'other' deliberately promises nothing. A code that means "none of these"
 *  cannot be dressed up as an explanation, and inventing one would be worse
 *  than the silence this feature exists to end. */
export const APPLICANT_REASON_LABELS: Record<RejectionReason, string> = {
  not_qualified:      'Your application did not meet the requirements for this role.',
  failed_requirement: 'A credential or licence the role requires was missing.',
  salary_mismatch:    'Salary expectations did not match what the role offers.',
  unreachable:        'The employer tried to reach you and could not. Check the phone number and email on your resume.',
  position_filled:    'The position was filled.',
  stronger_candidate: 'The role went to another candidate whose background was a closer fit.',
  withdrew_interest:  'This was recorded after you withdrew your interest.',
  other:              'The employer recorded a reason that does not fit any of the standard ones.',
};

/* ------------------------------------------------------------
   EVIDENCE-LINKED SKILLS, mirrored 1:1 from server/src/lib/engine.ts, which
   carries the full reasoning. The constant below is part of the PUBLISHED
   formula, not a tuning knob: the applicant is told "a skill you can point to
   evidence for counts fully; one you cannot counts half", and this is that
   half. Change it here and it must change there, or the number an applicant
   previews and the number a recruiter reads stop agreeing.
   ------------------------------------------------------------ */
export const UNEVIDENCED_CREDIT = 0.5;

export const EVIDENCE_KINDS: EvidenceKind[] = ['experience', 'project', 'certification', 'education', 'document'];

/** Normalise a skill's evidence to a list of sources, tolerating the older
 *  single-object shape. Mirrors server engine.ts. Scoring only asks whether
 *  the list is non-empty; extra sources record where a skill came from. */
export function evidenceSources(ev: SkillEvidence | SkillEvidence[] | null | undefined): SkillEvidence[] {
  if (!ev) return [];
  return (Array.isArray(ev) ? ev : [ev]).filter((s) => s && s.ref);
}

/** What each source type is called on screen. Kept apart from the stored
 *  value so the wording can be plain without changing what is saved. */
export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  experience:    'Work experience',
  project:       'Project',
  certification: 'Certification',
  education:     'Education',
  document:      'Uploaded resume file',
};

/** How one resume entry is labelled when it is offered as a source.
 *
 *  Mirrored from server/src/lib/engine.ts and covered by the parity test. The
 *  builder offers exactly these strings and the server accepts exactly these
 *  strings; if the two ever drift, a source the applicant picked would be
 *  refused on save and their score would drop for no visible reason. */
export function evidenceLabel(kind: EvidenceKind, e: any): string {
  const join = (a: unknown, b: unknown) => [String(a ?? '').trim(), String(b ?? '').trim()].filter(Boolean).join(', ');
  if (kind === 'experience') return join(e?.position, e?.company);
  if (kind === 'education') return join(e?.degree, e?.school);
  return String(e?.name ?? '').trim(); // project, certification, document
}

/** Every label on this resume a skill may point at, per kind. A source must
 *  be something already written down elsewhere on the same resume: that is
 *  the whole mechanism, and it is why this is a picker and not a text box. */
export function evidenceLabels(resume: {
  experience?: any[]; projects?: any[]; certifications?: any[]; education?: any[];
  ownFile?: { name?: string } | null;
}): Record<EvidenceKind, Set<string>> {
  const set = (kind: EvidenceKind, rows: any[] | undefined) =>
    new Set((rows ?? []).map((e) => evidenceLabel(kind, e)).filter(Boolean));
  const file = String(resume.ownFile?.name ?? '').trim();
  return {
    experience: set('experience', resume.experience),
    project: set('project', resume.projects),
    certification: set('certification', resume.certifications),
    education: set('education', resume.education),
    document: new Set(file ? [file] : []),
  };
}

export const STATUS_LABELS: Record<AppStatus, string> = {
  submitted: 'Applied',
  scheduling: 'For scheduling',
  initial_interview: 'For initial interview',
  testing: 'For testing',
  shortlisted: 'Shortlisted',
  final_interview: 'Final interview & selection',
  offer: 'Job offer',
  hired: 'Hired (onboarding)',
  rejected: 'Not selected',
  withdrawn: 'Withdrawn',
  review: 'Under review', // legacy — only for rows written before the pipeline was expanded
};
/** The statuses a RECRUITER may set, in the partner's pipeline order, with
 *  'rejected' as the off-ramp at the end. 'withdrawn' is deliberately absent:
 *  only the applicant can withdraw their own application, so it is never an
 *  option in a recruiter's status picker. 'review' is absent too — it is a
 *  legacy value that predates the eight-stage pipeline, kept renderable below
 *  but no longer offered. */
export const STATUS_ORDER: AppStatus[] = [
  'submitted', 'scheduling', 'initial_interview', 'testing', 'shortlisted',
  'final_interview', 'offer', 'hired', 'rejected',
];

/* Every status a row can actually hold. Counts and breakdowns must use this
   one, building them from STATUS_ORDER left 'withdrawn' out entirely, so a
   withdrawn application simply vanished from the recruiter's totals. 'review'
   is included for the same reason: a legacy row must still be counted. */
export const ALL_STATUSES: AppStatus[] = [...STATUS_ORDER, 'withdrawn', 'review'];

export const EDU_RANK: Record<EduLevel, number> = {
  // Ordinal positions; only their order and ratio matter to the score.
  // 'college_level' (some college, no degree yet) sits between a completed
  // associate and a bachelor, so it takes 3.5 rather than renumbering the
  // ladder — which would have shifted every existing education ratio.
  none: 0, highschool: 1, vocational: 2, associate: 3, college_level: 3.5, bachelor: 4, master: 5,
};
export const EDU_LABELS: Record<EduLevel, string> = {
  none: 'No requirement', highschool: 'High school', vocational: 'Vocational / TESDA',
  associate: 'Associate degree', college_level: 'College level (undergraduate)',
  bachelor: 'Bachelor’s degree', master: 'Master’s degree',
};

/** How a posting's minimum-experience requirement reads to a person. The
 *  partner states requirements in years (Clark Outsourcing information
 *  request, section 5), so the recruiter now enters years and this renders
 *  them: whole years read as years, a sub-year requirement as months (also
 *  the unit an applicant enters on their own resume), and a mixed one as both.
 *  The stored value stays months so the scoring engine is untouched. */
export function experienceLabel(months: number): string {
  const m = Math.max(0, Math.round(Number(months) || 0));
  if (m === 0) return 'No experience required';
  if (m % 12 === 0) { const y = m / 12; return `${y} year${y > 1 ? 's' : ''}`; }
  if (m < 12) return `${m} month${m > 1 ? 's' : ''}`;
  const y = Math.floor(m / 12), r = m % 12;
  return `${y} year${y > 1 ? 's' : ''} ${r} month${r > 1 ? 's' : ''}`;
}

/** Password rule for anything that SETS a password, mirrored in
 *  server/src/lib/password.ts. Never checked at login, so accounts made
 *  under the older 6-character rule keep working until their next change. */
export const PASSWORD_MIN = 8;
export const PASSWORD_HINT = 'At least 8 characters, including a letter and a number.';
export function passwordOk(p: string): boolean {
  return typeof p === 'string' && p.length >= PASSWORD_MIN && /[A-Za-z]/.test(p) && /\d/.test(p);
}

export const MAX_UPLOAD = 2 * 1024 * 1024; // 2 MB

/** THE MOST RESUMES ONE APPLICANT CAN KEEP. Twenty, and the reasons are
 *  practical, not a judgement about how many an applicant should want:
 *    · storage — each resume can carry its own 2 MB uploaded file, so twenty
 *      bounds one account at about 40 MB on a free-tier database and bucket;
 *    · the "which resume?" picker when applying stays short enough to read;
 *    · twenty is still more than one tailored resume per opening the
 *      platform typically lists, so nobody is stopped from tailoring.
 *  Reached, the applicant deletes one they no longer use; nothing is lost
 *  silently. Mirrored in server/src/config.ts; a parity test asserts the two agree. */
export const MAX_RESUMES = 20;

/* CONTACT DETAILS THAT CAN ACTUALLY BE USED. A recruiter replies by email
   or phone, so a value that cannot reach anyone is worse than a blank: the
   resume looks contactable and is not. Checked only when something is typed;
   whether one of the two is present at all is a separate rule. Kept
   deliberately permissive about FORMATTING (spaces, dashes, brackets, a
   leading +) and strict about SUBSTANCE (an @ and a domain; a plausible
   count of digits). Mirrored in server/src/lib/contact.ts — the two must
   agree, and a parity test runs both over the same inputs. */
export function emailProblem(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)
    ? null : 'Enter a valid email address, for example juan@gmail.com.';
}
/** Philippine mobile and landline numbers (0917 123 4567, (045) 123 4567,
 *  +63 917 123 4567), and an international number written with a leading +. */
export function phoneProblem(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = s.replace(/[\s\-().]/g, '');
  return /^0\d{8,10}$/.test(d) || /^\+?63\d{9,10}$/.test(d) || /^\+\d{8,15}$/.test(d)
    ? null : 'Enter a valid phone number, for example 0917 123 4567 or +63 917 123 4567.';
}
/** A LinkedIn PROFILE link: linkedin.com/in/… (any country subdomain, with or
 *  without https:// and www.). The field is labelled LinkedIn, so anything
 *  else typed there is a mistake a recruiter would click into. */
export function linkedinProblem(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return /^(https?:\/\/)?([a-z]{2,3}\.|www\.)?linkedin\.com\/(in|pub)\/[A-Za-z0-9\-_%.]{2,100}\/?$/i.test(s)
    ? null : 'Enter your LinkedIn profile link, for example linkedin.com/in/juandelacruz.';
}

/** WORK EXPERIENCE IN PRINTED ORDER: jobs still held first, then the rest in
 *  the order the applicant arranged them. Stable, so the applicant's own
 *  ordering within each group is kept. A resume reader looks at the top
 *  entry for what someone does NOW; a current job listed below a finished
 *  one reads as a gap. Used by every screen that renders the resume. */
export function experienceInPrintOrder<T extends { current?: boolean }>(list: readonly T[] | null | undefined): T[] {
  const all = [...(list ?? [])];
  return [...all.filter((e) => !!e?.current), ...all.filter((e) => !e?.current)];
}

/* WHAT AN APPLICANT ASKS BEFORE APPLYING — pay, shift, setup, where, how
   many. Never scored; stated facts about the job, shown on the advert and
   filterable. All optional: an opening that leaves one blank does not state
   it. The value lists mirror server/src/config.ts. */
export const SHIFT_LABELS = {
  day: 'Day shift', mid: 'Mid shift', night: 'Night shift', rotating: 'Rotating shifts', flexible: 'Flexible hours',
} as const;
export type Shift = keyof typeof SHIFT_LABELS;
export const WORK_SETUP_LABELS = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Work from home' } as const;
export type WorkSetup = keyof typeof WORK_SETUP_LABELS;
export const MAX_MONTHLY_SALARY = 1_000_000;
export const MAX_VACANCIES = 999;

const peso = (n: number) => '₱' + n.toLocaleString('en-PH');
/** "₱18,000 – ₱22,000 a month", "From ₱18,000 a month", or null when the
 *  opening states no pay. A single figure reads as that figure. */
export function salaryLabel(p: { salaryMin?: number | null; salaryMax?: number | null }): string | null {
  const lo = p.salaryMin ?? null, hi = p.salaryMax ?? null;
  if (lo === null && hi === null) return null;
  if (lo !== null && hi !== null) return lo === hi ? `${peso(lo)} a month` : `${peso(lo)} – ${peso(hi)} a month`;
  return lo !== null ? `From ${peso(lo)} a month` : `Up to ${peso(hi!)} a month`;
}
/** "3 openings", "1 opening", or null when the number is not stated. */
export function openingsLabel(p: { vacancies?: number | null }): string | null {
  const n = p.vacancies ?? null;
  return n === null ? null : `${n} opening${n === 1 ? '' : 's'}`;
}
export const ALLOWED_MIME = [
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png',
];

/* ------------------------------------------------------------
   SKILL ALIASES, mirrored 1:1 in server/src/lib/engine.ts.

   Without this, matching is literal: a seeker who writes "JS" gets
   zero credit for a posting asking for "JavaScript", and "MS Office"
   never matches "Microsoft Office". That is a false negative created
   purely by vocabulary, which is the exact unfairness this project
   argues against. So equivalent terms are folded to one canonical
   form before they are compared.

   Keys and values are already normalized (lowercase, alphanumeric).
   This only unifies genuine synonyms; it never guesses at related-
   but-different skills, so nothing is credited that wasn't claimed.
   ------------------------------------------------------------ */
export const SKILL_ALIASES: Record<string, string> = {
  // BPO
  listeningskills: 'activelistening',
  crm: 'crmsoftware', crmsystem: 'crmsoftware', crmtools: 'crmsoftware',
  callmanagement: 'callhandling',
  livechatsupport: 'chatsupport',
  conflictmanagement: 'conflictresolution',
  clientservice: 'customerservice', clientsupport: 'customerservice', csr: 'customerservice', customercare: 'customerservice', customersupport: 'customerservice',
  emailhandling: 'emailsupport',
  english: 'englishproficiency', englishcommunication: 'englishproficiency',
  inboundcall: 'inboundcalls',
  outboundcall: 'outboundcalls',
  qa: 'qualityassurance',
  typing: 'typingspeed',
  // Driver
  packagehandling: 'deliveryhandling',
  driving: 'professionaldriving',
  routeoptimization: 'routeplanning',
  safetyprocedures: 'safetycompliance',
  // Finance
  audit: 'auditing',
  reconciliation: 'bankreconciliation',
  bookkeeper: 'bookkeeping', bookkeepingsupport: 'bookkeeping',
  financialreports: 'financialreporting',
  invoiceprocessing: 'invoicing',
  payroll: 'payrollprocessing',
  qb: 'quickbooks', quickbooksonline: 'quickbooks',
  // General
  attentiontodetails: 'attentiontodetail', detailoriented: 'attentiontodetail',
  communicationskills: 'communication', oralcommunication: 'communication',
  leadershipskills: 'leadership',
  problemsolvingskills: 'problemsolving',
  collaboration: 'teamwork', teamplayer: 'teamwork',
  timemanagementskills: 'timemanagement',
  // Graphic Design
  illustrator: 'adobeillustrator',
  indesign: 'adobeindesign',
  photoshop: 'adobephotoshop',
  brandidentity: 'branding',
  pagelayout: 'layoutdesign',
  imageediting: 'photoediting',
  socialmediamanagement: 'socialmedia', socmed: 'socialmedia',
  // HR
  benefitsadministration: 'compensationandbenefits',
  employeerecords: 'hrrecords',
  laborlaw: 'laborlawcompliance',
  employeeonboarding: 'onboarding',
  performanceappraisal: 'performancemanagement',
  learninganddevelopment: 'traininganddevelopment',
  // IT Support
  computerrepair: 'hardwarerepair', pcrepair: 'hardwarerepair',
  helpdesk: 'helpdesksupport', servicedesk: 'helpdesksupport',
  network: 'computernetworking', networking: 'computernetworking',
  remotesupport: 'remotedesktopsupport',
  softwaresetup: 'softwareinstallation',
  ticketingsystem: 'ticketingsystems',
  technicalsupport: 'troubleshooting', techsupport: 'troubleshooting', troubleshoot: 'troubleshooting',
  // Medical Field
  bls: 'basiclifesupport',
  basicfirstaid: 'firstaid',
  infectionprevention: 'infectioncontrol',
  patientrecords: 'medicalrecords',
  medicalterms: 'medicalterminology',
  patienthandling: 'patientcare',
  pharmacysupport: 'pharmacyassistance',
  vitalsigns: 'vitalsignsmonitoring',
  // Office Management
  dataencoding: 'dataentry', encoding: 'dataentry',
  filing: 'filingandrecords', recordsmanagement: 'filingandrecords',
  inventory: 'inventorymanagement',
  microsoftofficesuite: 'microsoftoffice', msoffice: 'microsoftoffice', officesuite: 'microsoftoffice',
  excel: 'microsoftexcel', msexcel: 'microsoftexcel',
  msword: 'microsoftword', word: 'microsoftword',
  minutesofmeeting: 'minutetaking',
  administrativesupport: 'officeadministration', officeadmin: 'officeadministration',
  organizationalskills: 'organization',
  suppliesmanagement: 'supplymanagement',
  travelbooking: 'travelarrangements',
  // Recruitment
  applicanttrackingsystem: 'applicanttrackingsystems', ats: 'applicanttrackingsystems',
  backgroundcheck: 'backgroundchecking',
  conductinginterviews: 'interviewing',
  jobadvertising: 'jobposting',
  talentacquisition: 'recruitment',
  resumescreening: 'screeningresumes',
  candidatesourcing: 'sourcingcandidates', sourcing: 'sourcingcandidates',
  // Web Development
  angularjs: 'angular',
  css: 'htmlcss', css3: 'htmlcss', html: 'htmlcss', html5: 'htmlcss', htmlandcss: 'htmlcss',
  ecmascript: 'javascript', js: 'javascript',
  mysqldatabase: 'mysql',
  node: 'nodejs',
  restapi: 'restapis', restfulapi: 'restapis',
  reactjs: 'react',
  responsivedesign: 'responsivewebdesign',
  mssql: 'sql', sqlserver: 'sql',
  ts: 'typescript',
  // Added with the catalogue expansion — same rule as above:
  // genuine synonyms and spelling variants only.
  flexibility: 'adaptability',
  aftereffects: 'adobeaftereffects',
  adobepremiere: 'adobepremierepro', premiere: 'adobepremierepro', premierepro: 'adobepremierepro',
  acw: 'aftercallwork',
  barista: 'baristaskills',
  cctv: 'cctvmonitoring', cctvoperation: 'cctvmonitoring',
  coldcalls: 'coldcalling',
  articlewriting: 'contentwriting', blogwriting: 'contentwriting',
  retention: 'customerretention',
  dataanalytics: 'dataanalysis',
  backupandrecovery: 'databackup',
  datascrubbing: 'datacleaning',
  datavisualisation: 'datavisualization',
  dispatching: 'dispatchcoordination',
  wiring: 'electricalwiring',
  calibration: 'equipmentcalibration',
  escalations: 'escalationhandling',
  exitinterview: 'exitinterviews',
  foodhandling: 'foodsafety',
  forklift: 'forkliftoperation', forkliftdriving: 'forkliftoperation',
  frontdesk: 'frontdeskoperations',
  ga4: 'googleanalytics',
  googlesheet: 'googlesheets', gsheets: 'googlesheets',
  googleapps: 'googleworkspace', gsuite: 'googleworkspace',
  guestservice: 'guestrelations',
  roomcleaning: 'housekeeping',
  hrinformationsystem: 'hris',
  incidentreport: 'incidentreporting',
  peopleskills: 'interpersonalskills',
  labassistance: 'laboratoryassistance',
  leadgen: 'leadgeneration',
  m365: 'microsoft365administration', o365: 'microsoft365administration', office365: 'microsoft365administration',
  mspowerbi: 'microsoftpowerbi', powerbi: 'microsoftpowerbi',
  mongo: 'mongodb',
  negotiationskills: 'negotiation',
  cabling: 'networkcabling', structuredcabling: 'networkcabling',
  nursingaide: 'nursingassistance',
  oshs: 'occupationalsafety', safetytraining: 'occupationalsafety',
  packing: 'packingandlabeling',
  patrol: 'patrolling',
  pettycash: 'pettycashmanagement',
  postgres: 'postgresql',
  preventativemaintenance: 'preventivemaintenance',
  presentationskills: 'publicspeaking',
  python3: 'python',
  referencecheck: 'referencechecking',
  reservations: 'reservationshandling',
  salespresentation: 'salespresentations',
  sanitation: 'sanitationpractices',
  seo: 'searchengineoptimization',
  statistics: 'statisticalanalysis',
  sterilisation: 'sterilization',
  stocktaking: 'stockcontrol',
  waitering: 'tableservice', waitstaff: 'tableservice',
  tailwind: 'tailwindcss',
  talentpipeline: 'talentpipelining',
  drafting: 'technicaldrawing',
  trafficrules: 'trafficregulations',
  vue: 'vuejs',
  warehousing: 'warehouseoperations',
};

/* ------------------------------------------------------------
   SKILL CATEGORIES, keyed by the canonical normalised form, mirroring the
   `category` column of the seeded skills catalogue. An engine test reads
   db/linaw_ph.sql and fails if the two disagree, so this stays a copy
   of the database rather than a second opinion about it.

   Used for ONE purpose: telling an applicant what KIND of requirement they
   have not met, without naming it. See missingHint() below for why that
   distinction exists.
   ------------------------------------------------------------ */
export type SkillCategory = 'technical' | 'soft';

export const SKILL_CATEGORY: Record<string, SkillCategory> = {
  // BPO
  activelistening: 'soft',
  crmsoftware: 'technical',
  callhandling: 'technical',
  chatsupport: 'technical',
  conflictresolution: 'soft',
  customerservice: 'soft',
  emailsupport: 'technical',
  englishproficiency: 'soft',
  inboundcalls: 'technical',
  outboundcalls: 'technical',
  qualityassurance: 'technical',
  typingspeed: 'technical',
  // Driver
  defensivedriving: 'technical',
  deliveryhandling: 'technical',
  professionaldriving: 'technical',
  routeplanning: 'technical',
  safetycompliance: 'soft',
  vehiclemaintenance: 'technical',
  // Finance
  accountspayable: 'technical',
  accountsreceivable: 'technical',
  auditing: 'technical',
  bankreconciliation: 'technical',
  bookkeeping: 'technical',
  financialreporting: 'technical',
  invoicing: 'technical',
  payrollprocessing: 'technical',
  quickbooks: 'technical',
  taxation: 'technical',
  // General
  attentiontodetail: 'soft',
  communication: 'soft',
  leadership: 'soft',
  problemsolving: 'soft',
  teamwork: 'soft',
  timemanagement: 'soft',
  // Graphic Design
  adobeillustrator: 'technical',
  adobeindesign: 'technical',
  adobephotoshop: 'technical',
  branding: 'technical',
  canva: 'technical',
  copywriting: 'technical',
  figma: 'technical',
  layoutdesign: 'technical',
  photoediting: 'technical',
  socialmedia: 'technical',
  typography: 'technical',
  videoediting: 'technical',
  // HR
  compensationandbenefits: 'technical',
  employeerelations: 'soft',
  hrrecords: 'technical',
  laborlawcompliance: 'technical',
  onboarding: 'soft',
  performancemanagement: 'soft',
  traininganddevelopment: 'soft',
  // IT Support
  activedirectory: 'technical',
  hardwarerepair: 'technical',
  helpdesksupport: 'technical',
  linux: 'technical',
  computernetworking: 'technical',
  remotedesktopsupport: 'technical',
  softwareinstallation: 'technical',
  ticketingsystems: 'technical',
  troubleshooting: 'technical',
  windows: 'technical',
  // Medical Field
  basiclifesupport: 'technical',
  firstaid: 'technical',
  infectioncontrol: 'technical',
  medicalbilling: 'technical',
  medicalrecords: 'technical',
  medicalterminology: 'technical',
  patientcare: 'technical',
  pharmacyassistance: 'technical',
  vitalsignsmonitoring: 'technical',
  // Office Management
  dataentry: 'technical',
  filingandrecords: 'technical',
  inventorymanagement: 'technical',
  microsoftoffice: 'technical',
  microsoftexcel: 'technical',
  microsoftword: 'technical',
  minutetaking: 'technical',
  officeadministration: 'technical',
  organization: 'soft',
  scheduling: 'soft',
  supplymanagement: 'technical',
  travelarrangements: 'technical',
  // Recruitment
  applicanttrackingsystems: 'technical',
  backgroundchecking: 'soft',
  interviewing: 'soft',
  jobposting: 'soft',
  recruitment: 'soft',
  screeningresumes: 'soft',
  sourcingcandidates: 'soft',
  // Web Development
  angular: 'technical',
  git: 'technical',
  htmlcss: 'technical',
  javascript: 'technical',
  mysql: 'technical',
  nodejs: 'technical',
  php: 'technical',
  restapis: 'technical',
  react: 'technical',
  responsivewebdesign: 'technical',
  sql: 'technical',
  typescript: 'technical',
  wordpress: 'technical',
  // Sales and Marketing
  leadgeneration: 'technical',
  coldcalling: 'technical',
  salespresentations: 'soft',
  negotiation: 'soft',
  accountmanagement: 'soft',
  marketresearch: 'technical',
  emailmarketing: 'technical',
  searchengineoptimization: 'technical',
  googleanalytics: 'technical',
  contentwriting: 'technical',
  upselling: 'soft',
  clientonboarding: 'soft',
  // Hospitality and Food Service
  foodsafety: 'technical',
  foodpreparation: 'technical',
  housekeeping: 'technical',
  guestrelations: 'soft',
  frontdeskoperations: 'technical',
  tableservice: 'technical',
  bartending: 'technical',
  baristaskills: 'technical',
  reservationshandling: 'technical',
  sanitationpractices: 'technical',
  roominspection: 'technical',
  // Security and Safety
  accesscontrol: 'technical',
  cctvmonitoring: 'technical',
  incidentreporting: 'technical',
  patrolling: 'technical',
  emergencyresponse: 'technical',
  crowdcontrol: 'technical',
  firesafety: 'technical',
  occupationalsafety: 'technical',
  // Logistics and Warehousing
  warehouseoperations: 'technical',
  stockcontrol: 'technical',
  orderpicking: 'technical',
  forkliftoperation: 'technical',
  shippingandreceiving: 'technical',
  freightdocumentation: 'technical',
  dispatchcoordination: 'technical',
  packingandlabeling: 'technical',
  // Education and Training
  lessonplanning: 'technical',
  classroommanagement: 'soft',
  curriculumdevelopment: 'technical',
  tutoring: 'soft',
  studentassessment: 'technical',
  instructionalmaterials: 'technical',
  publicspeaking: 'soft',
  // Data and Analytics
  dataanalysis: 'technical',
  datavisualization: 'technical',
  microsoftpowerbi: 'technical',
  googlesheets: 'technical',
  statisticalanalysis: 'technical',
  reportwriting: 'technical',
  python: 'technical',
  datacleaning: 'technical',
  // Engineering and Trades
  autocad: 'technical',
  blueprintreading: 'technical',
  electricalwiring: 'technical',
  preventivemaintenance: 'technical',
  welding: 'technical',
  machineoperation: 'technical',
  equipmentcalibration: 'technical',
  technicaldrawing: 'technical',
  // BPO
  complainthandling: 'soft',
  orderprocessing: 'technical',
  escalationhandling: 'soft',
  aftercallwork: 'technical',
  customerretention: 'soft',
  // Driver
  vehicleinspection: 'technical',
  trafficregulations: 'technical',
  cargosecuring: 'technical',
  fuelmanagement: 'technical',
  // Finance
  xero: 'technical',
  sap: 'technical',
  financialanalysis: 'technical',
  budgeting: 'technical',
  costaccounting: 'technical',
  pettycashmanagement: 'technical',
  // General
  adaptability: 'soft',
  criticalthinking: 'soft',
  decisionmaking: 'soft',
  multitasking: 'soft',
  interpersonalskills: 'soft',
  workethic: 'soft',
  stressmanagement: 'soft',
  // Graphic Design
  adobepremierepro: 'technical',
  adobeaftereffects: 'technical',
  motiongraphics: 'technical',
  logodesign: 'technical',
  printproduction: 'technical',
  // HR
  timekeeping: 'technical',
  hris: 'technical',
  employeeengagement: 'soft',
  exitinterviews: 'technical',
  jobevaluation: 'technical',
  // IT Support
  microsoft365administration: 'technical',
  databackup: 'technical',
  networkcabling: 'technical',
  mobiledevicesupport: 'technical',
  antivirusmanagement: 'technical',
  servermaintenance: 'technical',
  // Medical Field
  phlebotomy: 'technical',
  sterilization: 'technical',
  medicalcoding: 'technical',
  nursingassistance: 'technical',
  laboratoryassistance: 'technical',
  // Office Management
  googleworkspace: 'technical',
  documentcontrol: 'technical',
  transcription: 'technical',
  calendarmanagement: 'technical',
  businesscorrespondence: 'technical',
  // Recruitment
  talentpipelining: 'technical',
  employerbranding: 'soft',
  referencechecking: 'technical',
  offernegotiation: 'soft',
  candidateengagement: 'soft',
  // Web Development
  vuejs: 'technical',
  bootstrap: 'technical',
  tailwindcss: 'technical',
  mongodb: 'technical',
  postgresql: 'technical',
  laravel: 'technical',
  docker: 'technical',
};

/* ------------------------------------------------------------
   THE SKILL CATALOGUE, display names and all. SKILL_CATEGORY above keys the
   same rows by their normalised form for scoring; this keeps the name a
   person actually reads, and the industry it belongs to.

   It exists so a recruiter writing their FIRST opening has something to pick
   from. The pool on the posting form used to be built only from skills that
   company had already used, which is empty on day one, so the recruiter had
   to type every skill from memory and any typo became a requirement nobody
   could match. Industry is presentation only and takes no part in scoring.

   Generated from db/linaw_ph.sql. An engine test fails if the two disagree.
   ------------------------------------------------------------ */
export interface CatalogueSkill { name: string; category: SkillCategory; industry: string }

export const SKILL_CATALOGUE: CatalogueSkill[] = [
  // BPO
  { name: 'Active Listening', category: 'soft', industry: 'BPO' },
  { name: 'CRM Software', category: 'technical', industry: 'BPO' },
  { name: 'Call Handling', category: 'technical', industry: 'BPO' },
  { name: 'Chat Support', category: 'technical', industry: 'BPO' },
  { name: 'Conflict Resolution', category: 'soft', industry: 'BPO' },
  { name: 'Customer Service', category: 'soft', industry: 'BPO' },
  { name: 'Email Support', category: 'technical', industry: 'BPO' },
  { name: 'English Proficiency', category: 'soft', industry: 'BPO' },
  { name: 'Inbound Calls', category: 'technical', industry: 'BPO' },
  { name: 'Outbound Calls', category: 'technical', industry: 'BPO' },
  { name: 'Quality Assurance', category: 'technical', industry: 'BPO' },
  { name: 'Typing Speed', category: 'technical', industry: 'BPO' },
  // Driver
  { name: 'Defensive Driving', category: 'technical', industry: 'Driver' },
  { name: 'Delivery Handling', category: 'technical', industry: 'Driver' },
  { name: 'Professional Driving', category: 'technical', industry: 'Driver' },
  { name: 'Route Planning', category: 'technical', industry: 'Driver' },
  { name: 'Safety Compliance', category: 'soft', industry: 'Driver' },
  { name: 'Vehicle Maintenance', category: 'technical', industry: 'Driver' },
  // Finance
  { name: 'Accounts Payable', category: 'technical', industry: 'Finance' },
  { name: 'Accounts Receivable', category: 'technical', industry: 'Finance' },
  { name: 'Auditing', category: 'technical', industry: 'Finance' },
  { name: 'Bank Reconciliation', category: 'technical', industry: 'Finance' },
  { name: 'Bookkeeping', category: 'technical', industry: 'Finance' },
  { name: 'Financial Reporting', category: 'technical', industry: 'Finance' },
  { name: 'Invoicing', category: 'technical', industry: 'Finance' },
  { name: 'Payroll Processing', category: 'technical', industry: 'Finance' },
  { name: 'QuickBooks', category: 'technical', industry: 'Finance' },
  { name: 'Taxation', category: 'technical', industry: 'Finance' },
  // General
  { name: 'Attention to Detail', category: 'soft', industry: 'General' },
  { name: 'Communication', category: 'soft', industry: 'General' },
  { name: 'Leadership', category: 'soft', industry: 'General' },
  { name: 'Problem Solving', category: 'soft', industry: 'General' },
  { name: 'Teamwork', category: 'soft', industry: 'General' },
  { name: 'Time Management', category: 'soft', industry: 'General' },
  // Graphic Design
  { name: 'Adobe Illustrator', category: 'technical', industry: 'Graphic Design' },
  { name: 'Adobe InDesign', category: 'technical', industry: 'Graphic Design' },
  { name: 'Adobe Photoshop', category: 'technical', industry: 'Graphic Design' },
  { name: 'Branding', category: 'technical', industry: 'Graphic Design' },
  { name: 'Canva', category: 'technical', industry: 'Graphic Design' },
  { name: 'Copywriting', category: 'technical', industry: 'Graphic Design' },
  { name: 'Figma', category: 'technical', industry: 'Graphic Design' },
  { name: 'Layout Design', category: 'technical', industry: 'Graphic Design' },
  { name: 'Photo Editing', category: 'technical', industry: 'Graphic Design' },
  { name: 'Social Media', category: 'technical', industry: 'Graphic Design' },
  { name: 'Typography', category: 'technical', industry: 'Graphic Design' },
  { name: 'Video Editing', category: 'technical', industry: 'Graphic Design' },
  // HR
  { name: 'Compensation and Benefits', category: 'technical', industry: 'HR' },
  { name: 'Employee Relations', category: 'soft', industry: 'HR' },
  { name: 'HR Records', category: 'technical', industry: 'HR' },
  { name: 'Labor Law Compliance', category: 'technical', industry: 'HR' },
  { name: 'Onboarding', category: 'soft', industry: 'HR' },
  { name: 'Performance Management', category: 'soft', industry: 'HR' },
  { name: 'Training and Development', category: 'soft', industry: 'HR' },
  // IT Support
  { name: 'Active Directory', category: 'technical', industry: 'IT Support' },
  { name: 'Hardware Repair', category: 'technical', industry: 'IT Support' },
  { name: 'Help Desk Support', category: 'technical', industry: 'IT Support' },
  { name: 'Linux', category: 'technical', industry: 'IT Support' },
  { name: 'Networking', category: 'technical', industry: 'IT Support' },
  { name: 'Remote Desktop Support', category: 'technical', industry: 'IT Support' },
  { name: 'Software Installation', category: 'technical', industry: 'IT Support' },
  { name: 'Ticketing Systems', category: 'technical', industry: 'IT Support' },
  { name: 'Troubleshooting', category: 'technical', industry: 'IT Support' },
  { name: 'Windows', category: 'technical', industry: 'IT Support' },
  // Medical Field
  { name: 'Basic Life Support', category: 'technical', industry: 'Medical Field' },
  { name: 'First Aid', category: 'technical', industry: 'Medical Field' },
  { name: 'Infection Control', category: 'technical', industry: 'Medical Field' },
  { name: 'Medical Billing', category: 'technical', industry: 'Medical Field' },
  { name: 'Medical Records', category: 'technical', industry: 'Medical Field' },
  { name: 'Medical Terminology', category: 'technical', industry: 'Medical Field' },
  { name: 'Patient Care', category: 'technical', industry: 'Medical Field' },
  { name: 'Pharmacy Assistance', category: 'technical', industry: 'Medical Field' },
  { name: 'Vital Signs Monitoring', category: 'technical', industry: 'Medical Field' },
  // Office Management
  { name: 'Data Entry', category: 'technical', industry: 'Office Management' },
  { name: 'Filing and Records', category: 'technical', industry: 'Office Management' },
  { name: 'Inventory Management', category: 'technical', industry: 'Office Management' },
  { name: 'MS Office', category: 'technical', industry: 'Office Management' },
  { name: 'Microsoft Excel', category: 'technical', industry: 'Office Management' },
  { name: 'Microsoft Word', category: 'technical', industry: 'Office Management' },
  { name: 'Minute Taking', category: 'technical', industry: 'Office Management' },
  { name: 'Office Administration', category: 'technical', industry: 'Office Management' },
  { name: 'Organization', category: 'soft', industry: 'Office Management' },
  { name: 'Scheduling', category: 'soft', industry: 'Office Management' },
  { name: 'Supply Management', category: 'technical', industry: 'Office Management' },
  { name: 'Travel Arrangements', category: 'technical', industry: 'Office Management' },
  // Recruitment
  { name: 'Applicant Tracking Systems', category: 'technical', industry: 'Recruitment' },
  { name: 'Background Checking', category: 'soft', industry: 'Recruitment' },
  { name: 'Interviewing', category: 'soft', industry: 'Recruitment' },
  { name: 'Job Posting', category: 'soft', industry: 'Recruitment' },
  { name: 'Recruitment', category: 'soft', industry: 'Recruitment' },
  { name: 'Screening Resumes', category: 'soft', industry: 'Recruitment' },
  { name: 'Sourcing Candidates', category: 'soft', industry: 'Recruitment' },
  // Web Development
  { name: 'Angular', category: 'technical', industry: 'Web Development' },
  { name: 'Git', category: 'technical', industry: 'Web Development' },
  { name: 'HTML/CSS', category: 'technical', industry: 'Web Development' },
  { name: 'JavaScript', category: 'technical', industry: 'Web Development' },
  { name: 'MySQL', category: 'technical', industry: 'Web Development' },
  { name: 'Node.js', category: 'technical', industry: 'Web Development' },
  { name: 'PHP', category: 'technical', industry: 'Web Development' },
  { name: 'REST APIs', category: 'technical', industry: 'Web Development' },
  { name: 'React', category: 'technical', industry: 'Web Development' },
  { name: 'Responsive Web Design', category: 'technical', industry: 'Web Development' },
  { name: 'SQL', category: 'technical', industry: 'Web Development' },
  { name: 'TypeScript', category: 'technical', industry: 'Web Development' },
  { name: 'WordPress', category: 'technical', industry: 'Web Development' },
  // Sales and Marketing
  { name: 'Lead Generation', category: 'technical', industry: 'Sales and Marketing' },
  { name: 'Cold Calling', category: 'technical', industry: 'Sales and Marketing' },
  { name: 'Sales Presentations', category: 'soft', industry: 'Sales and Marketing' },
  { name: 'Negotiation', category: 'soft', industry: 'Sales and Marketing' },
  { name: 'Account Management', category: 'soft', industry: 'Sales and Marketing' },
  { name: 'Market Research', category: 'technical', industry: 'Sales and Marketing' },
  { name: 'Email Marketing', category: 'technical', industry: 'Sales and Marketing' },
  { name: 'Search Engine Optimization', category: 'technical', industry: 'Sales and Marketing' },
  { name: 'Google Analytics', category: 'technical', industry: 'Sales and Marketing' },
  { name: 'Content Writing', category: 'technical', industry: 'Sales and Marketing' },
  { name: 'Upselling', category: 'soft', industry: 'Sales and Marketing' },
  { name: 'Client Onboarding', category: 'soft', industry: 'Sales and Marketing' },
  // Hospitality and Food Service
  { name: 'Food Safety', category: 'technical', industry: 'Hospitality and Food Service' },
  { name: 'Food Preparation', category: 'technical', industry: 'Hospitality and Food Service' },
  { name: 'Housekeeping', category: 'technical', industry: 'Hospitality and Food Service' },
  { name: 'Guest Relations', category: 'soft', industry: 'Hospitality and Food Service' },
  { name: 'Front Desk Operations', category: 'technical', industry: 'Hospitality and Food Service' },
  { name: 'Table Service', category: 'technical', industry: 'Hospitality and Food Service' },
  { name: 'Bartending', category: 'technical', industry: 'Hospitality and Food Service' },
  { name: 'Barista Skills', category: 'technical', industry: 'Hospitality and Food Service' },
  { name: 'Reservations Handling', category: 'technical', industry: 'Hospitality and Food Service' },
  { name: 'Sanitation Practices', category: 'technical', industry: 'Hospitality and Food Service' },
  { name: 'Room Inspection', category: 'technical', industry: 'Hospitality and Food Service' },
  // Security and Safety
  { name: 'Access Control', category: 'technical', industry: 'Security and Safety' },
  { name: 'CCTV Monitoring', category: 'technical', industry: 'Security and Safety' },
  { name: 'Incident Reporting', category: 'technical', industry: 'Security and Safety' },
  { name: 'Patrolling', category: 'technical', industry: 'Security and Safety' },
  { name: 'Emergency Response', category: 'technical', industry: 'Security and Safety' },
  { name: 'Crowd Control', category: 'technical', industry: 'Security and Safety' },
  { name: 'Fire Safety', category: 'technical', industry: 'Security and Safety' },
  { name: 'Occupational Safety', category: 'technical', industry: 'Security and Safety' },
  // Logistics and Warehousing
  { name: 'Warehouse Operations', category: 'technical', industry: 'Logistics and Warehousing' },
  { name: 'Stock Control', category: 'technical', industry: 'Logistics and Warehousing' },
  { name: 'Order Picking', category: 'technical', industry: 'Logistics and Warehousing' },
  { name: 'Forklift Operation', category: 'technical', industry: 'Logistics and Warehousing' },
  { name: 'Shipping and Receiving', category: 'technical', industry: 'Logistics and Warehousing' },
  { name: 'Freight Documentation', category: 'technical', industry: 'Logistics and Warehousing' },
  { name: 'Dispatch Coordination', category: 'technical', industry: 'Logistics and Warehousing' },
  { name: 'Packing and Labeling', category: 'technical', industry: 'Logistics and Warehousing' },
  // Education and Training
  { name: 'Lesson Planning', category: 'technical', industry: 'Education and Training' },
  { name: 'Classroom Management', category: 'soft', industry: 'Education and Training' },
  { name: 'Curriculum Development', category: 'technical', industry: 'Education and Training' },
  { name: 'Tutoring', category: 'soft', industry: 'Education and Training' },
  { name: 'Student Assessment', category: 'technical', industry: 'Education and Training' },
  { name: 'Instructional Materials', category: 'technical', industry: 'Education and Training' },
  { name: 'Public Speaking', category: 'soft', industry: 'Education and Training' },
  // Data and Analytics
  { name: 'Data Analysis', category: 'technical', industry: 'Data and Analytics' },
  { name: 'Data Visualization', category: 'technical', industry: 'Data and Analytics' },
  { name: 'Microsoft Power BI', category: 'technical', industry: 'Data and Analytics' },
  { name: 'Google Sheets', category: 'technical', industry: 'Data and Analytics' },
  { name: 'Statistical Analysis', category: 'technical', industry: 'Data and Analytics' },
  { name: 'Report Writing', category: 'technical', industry: 'Data and Analytics' },
  { name: 'Python', category: 'technical', industry: 'Data and Analytics' },
  { name: 'Data Cleaning', category: 'technical', industry: 'Data and Analytics' },
  // Engineering and Trades
  { name: 'AutoCAD', category: 'technical', industry: 'Engineering and Trades' },
  { name: 'Blueprint Reading', category: 'technical', industry: 'Engineering and Trades' },
  { name: 'Electrical Wiring', category: 'technical', industry: 'Engineering and Trades' },
  { name: 'Preventive Maintenance', category: 'technical', industry: 'Engineering and Trades' },
  { name: 'Welding', category: 'technical', industry: 'Engineering and Trades' },
  { name: 'Machine Operation', category: 'technical', industry: 'Engineering and Trades' },
  { name: 'Equipment Calibration', category: 'technical', industry: 'Engineering and Trades' },
  { name: 'Technical Drawing', category: 'technical', industry: 'Engineering and Trades' },
  // BPO
  { name: 'Complaint Handling', category: 'soft', industry: 'BPO' },
  { name: 'Order Processing', category: 'technical', industry: 'BPO' },
  { name: 'Escalation Handling', category: 'soft', industry: 'BPO' },
  { name: 'After-Call Work', category: 'technical', industry: 'BPO' },
  { name: 'Customer Retention', category: 'soft', industry: 'BPO' },
  // Driver
  { name: 'Vehicle Inspection', category: 'technical', industry: 'Driver' },
  { name: 'Traffic Regulations', category: 'technical', industry: 'Driver' },
  { name: 'Cargo Securing', category: 'technical', industry: 'Driver' },
  { name: 'Fuel Management', category: 'technical', industry: 'Driver' },
  // Finance
  { name: 'Xero', category: 'technical', industry: 'Finance' },
  { name: 'SAP', category: 'technical', industry: 'Finance' },
  { name: 'Financial Analysis', category: 'technical', industry: 'Finance' },
  { name: 'Budgeting', category: 'technical', industry: 'Finance' },
  { name: 'Cost Accounting', category: 'technical', industry: 'Finance' },
  { name: 'Petty Cash Management', category: 'technical', industry: 'Finance' },
  // General
  { name: 'Adaptability', category: 'soft', industry: 'General' },
  { name: 'Critical Thinking', category: 'soft', industry: 'General' },
  { name: 'Decision Making', category: 'soft', industry: 'General' },
  { name: 'Multitasking', category: 'soft', industry: 'General' },
  { name: 'Interpersonal Skills', category: 'soft', industry: 'General' },
  { name: 'Work Ethic', category: 'soft', industry: 'General' },
  { name: 'Stress Management', category: 'soft', industry: 'General' },
  // Graphic Design
  { name: 'Adobe Premiere Pro', category: 'technical', industry: 'Graphic Design' },
  { name: 'Adobe After Effects', category: 'technical', industry: 'Graphic Design' },
  { name: 'Motion Graphics', category: 'technical', industry: 'Graphic Design' },
  { name: 'Logo Design', category: 'technical', industry: 'Graphic Design' },
  { name: 'Print Production', category: 'technical', industry: 'Graphic Design' },
  // HR
  { name: 'Timekeeping', category: 'technical', industry: 'HR' },
  { name: 'HRIS', category: 'technical', industry: 'HR' },
  { name: 'Employee Engagement', category: 'soft', industry: 'HR' },
  { name: 'Exit Interviews', category: 'technical', industry: 'HR' },
  { name: 'Job Evaluation', category: 'technical', industry: 'HR' },
  // IT Support
  { name: 'Microsoft 365 Administration', category: 'technical', industry: 'IT Support' },
  { name: 'Data Backup', category: 'technical', industry: 'IT Support' },
  { name: 'Network Cabling', category: 'technical', industry: 'IT Support' },
  { name: 'Mobile Device Support', category: 'technical', industry: 'IT Support' },
  { name: 'Antivirus Management', category: 'technical', industry: 'IT Support' },
  { name: 'Server Maintenance', category: 'technical', industry: 'IT Support' },
  // Medical Field
  { name: 'Phlebotomy', category: 'technical', industry: 'Medical Field' },
  { name: 'Sterilization', category: 'technical', industry: 'Medical Field' },
  { name: 'Medical Coding', category: 'technical', industry: 'Medical Field' },
  { name: 'Nursing Assistance', category: 'technical', industry: 'Medical Field' },
  { name: 'Laboratory Assistance', category: 'technical', industry: 'Medical Field' },
  // Office Management
  { name: 'Google Workspace', category: 'technical', industry: 'Office Management' },
  { name: 'Document Control', category: 'technical', industry: 'Office Management' },
  { name: 'Transcription', category: 'technical', industry: 'Office Management' },
  { name: 'Calendar Management', category: 'technical', industry: 'Office Management' },
  { name: 'Business Correspondence', category: 'technical', industry: 'Office Management' },
  // Recruitment
  { name: 'Talent Pipelining', category: 'technical', industry: 'Recruitment' },
  { name: 'Employer Branding', category: 'soft', industry: 'Recruitment' },
  { name: 'Reference Checking', category: 'technical', industry: 'Recruitment' },
  { name: 'Offer Negotiation', category: 'soft', industry: 'Recruitment' },
  { name: 'Candidate Engagement', category: 'soft', industry: 'Recruitment' },
  // Web Development
  { name: 'Vue.js', category: 'technical', industry: 'Web Development' },
  { name: 'Bootstrap', category: 'technical', industry: 'Web Development' },
  { name: 'Tailwind CSS', category: 'technical', industry: 'Web Development' },
  { name: 'MongoDB', category: 'technical', industry: 'Web Development' },
  { name: 'PostgreSQL', category: 'technical', industry: 'Web Development' },
  { name: 'Laravel', category: 'technical', industry: 'Web Development' },
  { name: 'Docker', category: 'technical', industry: 'Web Development' },
];

/** The catalogue as it SHIPS. SKILL_CATALOGUE above becomes the live one
 *  once the app has loaded the admins' edits (setCatalogue); this copy is
 *  what a new demo database starts from, and what the engine test checks
 *  against db/linaw_ph.sql. */
export const BUILT_IN_CATALOGUE: readonly CatalogueSkill[] = SKILL_CATALOGUE.map((c) => ({ ...c }));

/** Catalogue names grouped by industry, for a browsable picker. */
export const SKILL_BY_INDUSTRY: Array<[string, string[]]> = [];
/* DERIVED from SKILL_CATALOGUE rather than written out again. It used to be
   a second hand-maintained copy of the same grouping, which meant adding a
   skill in one place and forgetting the other left the posting form quietly
   offering a different set than the catalogue held. Industries appear in
   the order the catalogue first mentions them, and the names within each
   stay in catalogue order. Rebuilt in place, so anything holding the array
   sees the current catalogue. */
function groupByIndustry(): void {
  const by = new Map<string, string[]>();
  for (const s of SKILL_CATALOGUE) {
    const list = by.get(s.industry);
    if (list) list.push(s.name); else by.set(s.industry, [s.name]);
  }
  SKILL_BY_INDUSTRY.splice(0, SKILL_BY_INDUSTRY.length, ...[...by]);
}
groupByIndustry();

/** Adopt the dictionary from /api/skills/dictionary: the admins' catalogue
 *  and their linked synonyms. */
export function applyDictionary(d: { catalogue: readonly CatalogueSkill[]; links: readonly { aliasNorm: string; targetNorm: string }[] }): void {
  setCatalogue(d.catalogue);
  setLinkedSkills(Object.fromEntries((d.links || []).map((l) => [l.aliasNorm, l.targetNorm])));
}

/** Replace the catalogue with the one the admins keep (from the skill
 *  dictionary). In place, so every page that imported SKILL_CATALOGUE or
 *  SKILL_BY_INDUSTRY reads the new one. An empty list is ignored: a picker
 *  with nothing in it is never the right answer. */
export function setCatalogue(list: readonly CatalogueSkill[]): void {
  if (!list?.length) return;
  SKILL_CATALOGUE.splice(0, SKILL_CATALOGUE.length, ...list.map((c) => ({ ...c })));
  for (const c of list) SKILL_CATEGORY[normSkillBuiltIn(c.name)] = c.category;
  groupByIndustry();
}

/** How the applicant is told about a requirement they have not met.
 *
 *  NOT BY NAME, and that is the point. The site used to print the missing
 *  skills as a list, "missing: Troubleshooting, Windows, Networking", which
 *  is a ready-made set of words to paste into a resume. Naming them turned an
 *  explanation into an instruction.
 *
 *  So the applicant is told HOW MANY and WHAT KIND, which is enough to act on
 *  honestly and not enough to copy. Someone who really does troubleshoot reads
 *  "two technical skills" and goes to check the posting; someone who does not
 *  is given no word to claim.
 *
 *  Be clear about the limit: the opening itself still states what it asks for,
 *  because a job advert that hides its requirements is not a job advert. What
 *  this removes is the system doing the comparison and handing over the
 *  difference. The recruiter's own view is unchanged, see hr-applicants,
 *  where missing skills are still named, because the person deciding needs to
 *  know exactly what is absent. */
export function missingHint(missing: string[]): string {
  if (!missing.length) return '';
  let tech = 0, soft = 0;
  for (const s of missing) (SKILL_CATEGORY[normSkill(s)] === 'soft' ? soft++ : tech++);
  const parts: string[] = [];
  if (tech) parts.push(`${tech} technical`);
  if (soft) parts.push(`${soft} workplace`);
  const kinds = parts.join(' and ');
  const n = missing.length;
  return `${n} ${n === 1 ? 'skill' : 'skills'} this role asks for ${n === 1 ? 'is' : 'are'} not on your resume, ${kinds}`;
}

/** Does this job's own words mention any of the skills the opening asks for?
 *
 *  Used only by the optional relevant-experience component. The text is split
 *  into words and read as runs of one to four consecutive words, each run put
 *  through normSkill() and compared against the opening's own required
 *  skills. That gives three properties worth having:
 *
 *    WORD BOUNDARIES. A plain substring test would find "git" inside
 *    "digital" and "legitimate", crediting a receptionist with version
 *    control. Runs are whole words, so it cannot.
 *
 *    MULTI-WORD SKILLS. "Customer Service" is two words in a sentence and one
 *    skill in the catalogue. Runs up to four words long find it.
 *
 *    THE SAME SYNONYMS AS EVERYWHERE ELSE. Each run goes through normSkill(),
 *    so a description saying "MS Office" satisfies an opening asking for
 *    "Microsoft Office" — the one alias table, not a second set of rules.
 *
 *  A skill the vocabulary does not know simply fails to match, which costs
 *  the applicant credit and never awards it wrongly. That is the same
 *  direction every other near-miss in this engine errs in. */
export function jobMentionsAny(text: string, skills: readonly string[]): boolean {
  if (!text || !skills.length) return false;
  const wanted = new Set(skills.map(normSkill).filter(Boolean));
  if (!wanted.size) return false;
  const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      if (wanted.has(normSkill(words.slice(i, i + n).join(' ')))) return true;
    }
  }
  return false;
}

/** WHAT UNRELATED COUNTS FOR, beside related. Applied to both halves of the
 *  panel's revision: a month of work unrelated to the opening counts half a
 *  month, and a degree in another field counts half a degree.
 *
 *  Half, not zero, and deliberately the same number as UNEVIDENCED_CREDIT, so
 *  the whole engine follows one rule that can be said in a sentence: what you
 *  can show is related counts fully; the rest still counts, at half. Zero
 *  would score a fresh graduate whose only jobs were part-time work outside
 *  their course as having no experience at all, which is not true, and is
 *  exactly the applicant this study is for. Mirrored in server/src/lib/engine.ts. */
export const UNRELATED_CREDIT = 0.5;

/* Words that say how senior or how employed someone was, never what the job
   was ABOUT. Sharing "Intern" does not make a sales internship relevant to an
   IT one, and sharing "Manager" does not make a store manager a social media
   manager. Kept short on purpose: every word added here is a match removed,
   so only words that carry no subject belong in it. */
const ROLE_WORDS = new Set([
  'intern', 'interns', 'internship', 'ojt', 'trainee', 'apprentice',
  'assistant', 'asst', 'associate', 'junior', 'jr', 'senior', 'sr',
  'staff', 'officer', 'specialist', 'agent', 'representative', 'rep',
  'clerk', 'worker', 'employee', 'volunteer', 'student', 'lead', 'head',
  'manager', 'supervisor', 'coordinator', 'executive', 'member', 'crew',
  'helper', 'aide', 'part', 'full', 'time', 'parttime', 'fulltime',
  'contract', 'contractual', 'temporary', 'seasonal', 'freelance', 'freelancer',
  'and', 'of', 'the', 'for', 'in', 'at', 'to', 'a', 'an', 'on', 'with',
  'i', 'ii', 'iii', 'iv',
]);

/** The words in a job title that say what the job was about. */
export function titleWords(text: string): Set<string> {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !ROLE_WORDS.has(w)));
}

/** IS THIS JOB RELEVANT TO THIS OPENING? The panel asked for the job's title
 *  and description to be read, not only its length. Two tests, either enough:
 *
 *    · its title, description or bullets mention a skill the opening asks
 *      for — read by the same word runs and synonyms the skills component
 *      uses, so "JS" in a bullet counts for "JavaScript"; or
 *    · its title shares a subject word with the opening's title —
 *      "Web Development Intern" and "Junior Web Developer" share "web";
 *      "Customer Service Representative" and "Customer Support Agent" share
 *      "customer". Seniority and employment words are ignored (ROLE_WORDS).
 *
 *  No similarity score and no guessing: a recruiter can predict it, and an
 *  applicant can be told exactly which word made a job count. */
export function experienceRelevant(e: any, posting: any, required: readonly string[]): boolean {
  const stated = String(e?.field || '');
  if (stated && stated !== JOB_FIELD_OTHER && openingJobFields(posting).has(stated)) return true;
  const text = [e?.position, e?.description, ...(Array.isArray(e?.bullets) ? e.bullets : [])]
    .filter(Boolean).join(' ');
  if (jobMentionsAny(text, required)) return true;
  const want = titleWords(String(posting?.title || ''));
  if (!want.size) return false;
  for (const w of titleWords(String(e?.position || ''))) if (want.has(w)) return true;
  return false;
}

/* ------------------------------------------------------------
   FIELD OF STUDY — what a degree is ABOUT, not what level it is.

   The education component scores a level against a level: a bachelor's in
   nursing and a bachelor's in IT are the same number to it. The manuscript
   says so and gives the reason — a posting records a required LEVEL and has
   no field for a required COURSE, so scoring the field would have meant
   inventing a requirement the recruiter never set.

   The opening's DEPARTMENT is that missing requirement. It is already typed
   on every posting, so nothing new is asked of the recruiter: a degree is
   read for what it is about, the department is read the same way, and the
   two are compared.

   BOTH SIDES GO THROUGH THE SAME VOCABULARY, which is the only reason this
   is defensible. A one-directional list would let the two drift into
   answering different questions.

   A department this vocabulary cannot place scores FULL MARKS. That is the
   rule every other component follows — a requirement nobody stated cannot be
   one the applicant failed — and it is the honest answer for a BPO opening,
   where in practice almost any degree is accepted.
   ------------------------------------------------------------ */
export const EDU_FIELD_VOCAB: Record<string, string> = {
  // information technology
  informationtechnology: 'it', computerscience: 'it', computerengineering: 'it',
  informationsystems: 'it', softwareengineering: 'it', computerstudies: 'it',
  it: 'it', ict: 'it', cs: 'it', datascience: 'it', informationtech: 'it',
  // healthcare
  nursing: 'healthcare', pharmacy: 'healthcare', medicaltechnology: 'healthcare',
  medtech: 'healthcare', midwifery: 'healthcare', radiologictechnology: 'healthcare',
  physicaltherapy: 'healthcare', medicine: 'healthcare', caregiving: 'healthcare',
  nutrition: 'healthcare', dentistry: 'healthcare', healthcare: 'healthcare',
  // finance and accounting
  accountancy: 'finance', accounting: 'finance', accountingtechnology: 'finance',
  bankingandfinance: 'finance', financialmanagement: 'finance', finance: 'finance',
  internalauditing: 'finance', economics: 'finance',
  // business and administration
  businessadministration: 'business', businessmanagement: 'business',
  entrepreneurship: 'business', officeadministration: 'admin',
  administration: 'admin', officemanagement: 'admin', businessstudies: 'business',
  // marketing
  marketingmanagement: 'marketing', marketing: 'marketing', advertising: 'marketing',
  digitalmarketing: 'marketing', multimediaarts: 'marketing', graphicdesign: 'marketing',
  // education
  elementaryeducation: 'education', secondaryeducation: 'education',
  education: 'education', teaching: 'education',
  // engineering and trades
  civilengineering: 'engineering', mechanicalengineering: 'engineering',
  electricalengineering: 'engineering', industrialengineering: 'engineering',
  electronicsengineering: 'engineering', engineering: 'engineering',
  // hospitality and tourism
  hotelandrestaurantmanagement: 'hospitality', hospitalitymanagement: 'hospitality',
  tourism: 'hospitality', tourismmanagement: 'hospitality', culinaryarts: 'hospitality',
  hrm: 'hospitality',
  // human resources
  humanresource: 'hr', humanresources: 'hr', humanresourcemanagement: 'hr',
  psychology: 'hr', industrialpsychology: 'hr',
  // communication
  masscommunication: 'communication', communication: 'communication',
  journalism: 'communication', broadcasting: 'communication', englishlanguage: 'communication',
  // security
  criminology: 'security', criminaljustice: 'security',
  // logistics
  supplychainmanagement: 'logistics', logistics: 'logistics', customsadministration: 'logistics',
  // THE ABBREVIATIONS APPLICANTS ACTUALLY TYPE. Written as one word they are
  // one token, so "BSIT" never reached the "it" entry the way "BS IT" does.
  // Only the forms that mean one thing in Philippine schools are listed; an
  // ambiguous one (BSMT: medical technology or marine transportation) is not.
  bsit: 'it', bscs: 'it', bsis: 'it', bscpe: 'it', bscoe: 'it', bsemc: 'it', bsict: 'it',
  bsn: 'healthcare', bspharma: 'healthcare', bspt: 'healthcare', bsmls: 'healthcare',
  medicallaboratoryscience: 'healthcare', bsrt: 'healthcare',
  bsa: 'finance', bsma: 'finance', bsais: 'finance', managementaccounting: 'finance',
  accountinginformationsystem: 'finance', accountinginformationsystems: 'finance',
  bsba: 'business', bsentrep: 'business', bsoa: 'admin',
  bsed: 'education', beed: 'education',
  bsce: 'engineering', bsme: 'engineering', bsee: 'engineering', bsece: 'engineering', bsie: 'engineering',
  bshm: 'hospitality', bshrm: 'hospitality', bstm: 'hospitality',
  bspsych: 'hr', bscrim: 'security', abcomm: 'communication', bacomm: 'communication',
};

/** Which fields does this text belong to? Used for BOTH a degree and an
 *  opening's department, so the two are read by one set of rules.
 *
 *  Words, not substrings, and runs of up to four words, for the same reasons
 *  jobMentionsAny() takes that shape: "it" must not be found inside
 *  "hospitality", and "Information Technology" is two words in a sentence and
 *  one field here. A text naming several fields resolves to several — "HR and
 *  Marketing" is a real department — and a match needs only one in common. */
/** Degrees offered as autocomplete in the builder's education step.
 *
 *  A SHORTCUT, NOT A LIST OF PERMITTED ANSWERS. The field stays free text —
 *  a degree missing from here is typed normally and still placed by
 *  EDU_FIELD_VOCAB, which reads the words rather than looking the whole
 *  string up. The catalogue exists so the common cases are spelled the way
 *  the vocabulary already knows, which is the same reason the skills step
 *  offers a list. */
export const DEGREE_CATALOGUE: readonly string[] = [
  'BS Information Technology', 'BS Computer Science', 'BS Computer Engineering',
  'BS Information Systems', 'BS Software Engineering',
  'BS Nursing', 'BS Pharmacy', 'BS Medical Technology', 'BS Midwifery',
  'BS Radiologic Technology', 'BS Physical Therapy', 'BS Nutrition and Dietetics',
  'BS Accountancy', 'BS Accounting Technology', 'BS Banking and Finance',
  'BS Financial Management', 'BS Economics', 'BS Internal Auditing',
  'BS Business Administration', 'BS Business Management', 'BS Entrepreneurship',
  'BS Office Administration', 'BS Marketing Management', 'BS Advertising',
  'BS Elementary Education', 'BS Secondary Education',
  'BS Civil Engineering', 'BS Mechanical Engineering', 'BS Electrical Engineering',
  'BS Industrial Engineering', 'BS Electronics Engineering',
  'BS Hotel and Restaurant Management', 'BS Hospitality Management',
  'BS Tourism Management', 'BS Culinary Arts',
  'BS Psychology', 'BS Human Resource Management',
  'AB Mass Communication', 'AB Communication', 'AB Journalism', 'AB English',
  'BS Criminology', 'BS Customs Administration', 'BS Supply Chain Management',
  'BS Multimedia Arts', 'Senior High School - STEM', 'Senior High School - ABM',
  'Senior High School - HUMSS', 'Senior High School - TVL',
];

export function educationFields(text: string): Set<string> {
  const out = new Set<string>();
  const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const hit = EDU_FIELD_VOCAB[words.slice(i, i + n).join('')];
      if (hit) out.add(hit);
    }
  }
  return out;
}

/** WHAT A RECRUITER MAY ASK FOR, as the field-of-study picker offers it.
 *
 *  The value of every entry is a tag EDU_FIELD_VOCAB already produces — an
 *  engine test asserts the two agree, so a field can never be offered that no
 *  degree can satisfy, nor a degree placed in a field nobody can ask for.
 *  The labels are the recruiter's words; the tags are the engine's. */
export const EDU_FIELD_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'it', label: 'Information technology and computing' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'healthcare', label: 'Healthcare and allied health' },
  { value: 'finance', label: 'Finance, accounting and economics' },
  { value: 'business', label: 'Business and management' },
  { value: 'admin', label: 'Office administration' },
  { value: 'marketing', label: 'Marketing, advertising and design' },
  { value: 'communication', label: 'Communication and media' },
  { value: 'hr', label: 'Human resources and psychology' },
  { value: 'education', label: 'Education and teaching' },
  { value: 'hospitality', label: 'Hospitality and tourism' },
  { value: 'logistics', label: 'Logistics and supply chain' },
  { value: 'security', label: 'Criminology and security' },
];

/** The two choices that are not a field. Stored in the same column, because
 *  to the engine they are answers to the same question. */
export const EDU_FIELD_ANY = 'any';
export const EDU_FIELD_FROM_DEPARTMENT = '';

/** WHICH FIELDS THIS OPENING ACCEPTS. One place, so the client, the server
 *  and the recruiter's own preview cannot disagree about it.
 *
 *  An EMPTY SET means "accepts anything", which is what both `any` and an
 *  unplaceable department come to — a requirement nobody stated cannot be one
 *  the applicant failed, the rule every other component follows.
 *
 *  A posting saved before this picker existed has no stored choice, and falls
 *  back to reading the department exactly as it did then. That fallback is
 *  what keeps every already-published opening scoring the same. */
export function acceptedFields(posting: any): Set<string> {
  const chosen = String(posting?.educationField ?? '').trim().toLowerCase();
  if (chosen === EDU_FIELD_ANY) return new Set<string>();
  if (chosen && EDU_FIELD_OPTIONS.some((o) => o.value === chosen)) return new Set([chosen]);
  return educationFields(String(posting?.department || ''));
}

/* ------------------------------------------------------------
   FIELD OF WORK — what a JOB was about, stated by the applicant.

   Reading a job's own words (experienceRelevant below) misses related work
   written another way: "Administrative Staff" never says "admin", a
   freelancer who "built websites" never says "web developer". So each job
   can also carry the field the applicant says it was in, chosen from the
   same fields a degree is read into, plus customer service and BPO, which
   is most of the work in a BPO town and is not a field of study.

   It is STATED, not verified, so it never takes anything away: a job counts
   as related when its stated field matches the opening's OR its own words
   do, and the recruiter sees the stated field beside the job. A job with no
   field stated is judged exactly as before.
   ------------------------------------------------------------ */
export const JOB_FIELD_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'customer_service', label: 'Customer service and BPO' },
  ...EDU_FIELD_OPTIONS,
];
/** "None of these": stored, so the builder does not keep suggesting. */
export const JOB_FIELD_OTHER = 'other';

/** Words that place a JOB (or an opening's title and department) in a field,
 *  on top of the degree vocabulary. Kept apart from EDU_FIELD_VOCAB on
 *  purpose: added there, "Customer Support" as a department would start
 *  asking every applicant for a customer-service DEGREE. */
export const JOB_FIELD_VOCAB: Record<string, string> = {
  // customer service and BPO
  customerservice: 'customer_service', customersupport: 'customer_service', customercare: 'customer_service',
  customerexperience: 'customer_service', callcenter: 'customer_service', callcentre: 'customer_service',
  contactcenter: 'customer_service', contactcentre: 'customer_service', bpo: 'customer_service',
  csr: 'customer_service', tsr: 'customer_service', telesales: 'customer_service', telemarketing: 'customer_service',
  chatsupport: 'customer_service', emailsupport: 'customer_service', technicalsupport: 'customer_service',
  techsupport: 'customer_service',
  // information technology
  developer: 'it', programmer: 'it', webdeveloper: 'it', webdevelopment: 'it', softwaredeveloper: 'it',
  softwareengineer: 'it', helpdesk: 'it', itsupport: 'it', networkadministrator: 'it', qatester: 'it',
  // healthcare
  nurse: 'healthcare', caregiver: 'healthcare', pharmacist: 'healthcare', medicalcoder: 'healthcare',
  medicalbiller: 'healthcare', patient: 'healthcare',
  // finance
  accountant: 'finance', bookkeeper: 'finance', bookkeeping: 'finance', auditor: 'finance', payroll: 'finance',
  // office administration
  encoder: 'admin', dataentry: 'admin', secretary: 'admin', receptionist: 'admin', admin: 'admin',
  administrative: 'admin', clerical: 'admin', virtualassistant: 'admin',
  // human resources
  hr: 'hr', recruiter: 'hr', recruitment: 'hr', talentacquisition: 'hr',
  // marketing and sales
  sales: 'marketing', socialmedia: 'marketing', seo: 'marketing', graphicdesigner: 'marketing',
  // communication
  writer: 'communication', contentwriter: 'communication', copywriter: 'communication', editor: 'communication',
  // education
  teacher: 'education', tutor: 'education', instructor: 'education',
  // hospitality
  chef: 'hospitality', cook: 'hospitality', waiter: 'hospitality', barista: 'hospitality',
  housekeeping: 'hospitality', frontdesk: 'hospitality', hotel: 'hospitality', restaurant: 'hospitality',
  // security
  securityguard: 'security', guard: 'security',
  // logistics
  warehouse: 'logistics', dispatcher: 'logistics', inventory: 'logistics', delivery: 'logistics',
};

/** The fields a job title (or any text about work) points to: the degree
 *  vocabulary and the job vocabulary together, read word by word the same
 *  way as educationFields(). */
export function jobFields(text: string): Set<string> {
  const out = new Set<string>();
  const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const k = words.slice(i, i + n).join('');
      const hit = JOB_FIELD_VOCAB[k] ?? EDU_FIELD_VOCAB[k];
      if (hit) out.add(hit);
    }
  }
  return out;
}

/** The field the builder suggests for a job: read from its position first,
 *  then from what the applicant wrote they did. Null when nothing is clear. */
export function suggestJobField(e: { position?: string; description?: string } | null | undefined): string | null {
  for (const text of [e?.position, e?.description]) {
    const f = [...jobFields(String(text || ''))];
    if (f.length) return f[0];
  }
  return null;
}

/** The fields an opening's work is in: its department and title, read the
 *  same way, plus the field of study the recruiter picked, if they picked
 *  one. Empty when nothing can be placed, and then only the job's own words
 *  can make it related. */
export function openingJobFields(posting: any): Set<string> {
  const out = jobFields(`${posting?.department || ''} ${posting?.title || ''}`);
  const chosen = String(posting?.educationField ?? '').trim().toLowerCase();
  if (chosen && chosen !== EDU_FIELD_ANY && EDU_FIELD_OPTIONS.some((o) => o.value === chosen)) out.add(chosen);
  return out;
}

/** Normalize a skill to its canonical comparable form: strip case and
 *  punctuation, then fold known synonyms together. Used for BOTH sides
 *  of every comparison, so a resume and a posting that mean the same
 *  thing land on it. */
export function normSkill(s: string): string {
  const base = skillBase(s);
  const canon = SKILL_ALIASES[base] ?? base;
  return LINKED_SKILLS[canon] ?? canon;
}

/** A skill with case and punctuation stripped and NO synonyms applied. */
export function skillBase(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** normSkill without the admins' links: what the server's skills table
 *  would have stored the term as, which is how the demo counts usage. */
export function normSkillBuiltIn(s: string): string {
  const base = skillBase(s);
  return SKILL_ALIASES[base] ?? base;
}

/* SYNONYMS LINKED BY AN ADMIN in the skill dictionary, on top of the
   built-in SKILL_ALIASES. Mirrors setLinkedSkills() in
   server/src/lib/engine.ts: applied after the built-in list, one step only
   (the dictionary refuses chains). Filled from /api/skills/dictionary when
   the app starts, and by the demo adapter from its own store. */
let LINKED_SKILLS: Record<string, string> = {};
export function setLinkedSkills(map: Record<string, string>): void {
  LINKED_SKILLS = { ...map };
}
export function linkedSkills(): Readonly<Record<string, string>> {
  return LINKED_SKILLS;
}

/** Mirrored 1:1 in server/src/lib/engine.ts (rmScore()). Rule-based
 *  only: no ML, no AI. The applicant's uploaded file is never read here. */
/** The weights ONE posting is scored with, the browser's mirror of
 *  weightsFor() in server/src/lib/engine.ts, and it must stay identical: the
 *  live score shown while a seeker edits their resume has to equal the score
 *  the server stores when they apply.
 *
 *  A posting that names its own overrides the site defaults; one that does not
 *  inherits them, so retuning match_settings still moves every opening that
 *  never customised. A malformed or partial set is rejected wholesale rather
 *  than repaired, normalising it would score the applicant on a scale the
 *  recruiter never chose. */
export function weightsFor(posting: Pick<Posting, 'weights'>): typeof WEIGHTS {
  const w = posting.weights;
  if (!w) return WEIGHTS;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!ok(w.skills) || !ok(w.education) || !ok(w.experience)) return WEIGHTS;
  /* Absent means zero, not invalid — an opening written before a component
     was scoreable carries only the weights that existed then, and must keep
     the score it has always produced. */
  const opt: Record<string, number> = {};
  for (const k of OPTIONAL_WEIGHTS) {
    const v = (w as Record<string, unknown>)[k];
    const n = v === undefined || v === null ? 0 : v;
    if (!ok(n)) return WEIGHTS;
    opt[k] = n;
  }
  const total = w.skills + w.education + w.experience
    + OPTIONAL_WEIGHTS.reduce((s, k) => s + opt[k], 0);
  if (total !== 100) return WEIGHTS;
  // Percentages in, fractions out, the same single conversion the server does.
  return {
    skills: w.skills / 100, education: w.education / 100, experience: w.experience / 100,
    certifications: opt['certifications'] / 100, projects: opt['projects'] / 100,
    languages: opt['languages'] / 100, references: opt['references'] / 100,
    relevance: opt['relevance'] / 100, field: opt['field'] / 100,
  };
}

/** The browser's mirror of certNorm() in server/src/lib/engine.ts. Free text,
 *  reduced to lowercase alphanumerics; the applicant's entry must CONTAIN what
 *  the opening asked for. */
export function normCert(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ============================================================
   SECTIONS THE APPLICANT SWITCHED OFF.

   Mirrors visibleResume() in server/src/lib/serializers.ts and must stay
   identical: the two are the same rule, and a resume that scored one way in
   the browser and another on the server would make the published formula
   untrue of one of them.

   Hiding a section removes it from the printed sheet AND from the score.
   Those move together on purpose -- a recruiter has to be able to read the
   number as a statement about the document in front of them, and a section
   they will never see must not be quietly earning marks toward it.
   ============================================================ */
export const RESUME_SECTIONS = ['summary', 'projects', 'certifications', 'languages', 'references', 'links'] as const;

/** A copy of a resume with the switched-off sections removed. Idempotent and
 *  a no-op when nothing is hidden, so it is safe anywhere. */
export function visibleResume<T extends { hiddenSections?: readonly string[] }>(resume: T): T {
  const hidden = resume?.hiddenSections;
  if (!hidden?.length) return resume;
  const out: any = { ...resume };
  // The summary lives inside `personal`, so it is blanked rather than deleted
  // -- the rest of that object is contact detail and always shows.
  if (hidden.includes('summary')) out.personal = { ...(out.personal ?? {}), summary: '' };
  for (const k of ['projects', 'certifications', 'languages', 'references', 'links']) {
    if (hidden.includes(k)) delete out[k];
  }
  return out as T;
}

export function scoreLocal(
  resume: Pick<Resume, 'skills' | 'education' | 'experience'>
    & {
      skillEvidence?: Resume['skillEvidence']; certifications?: { name?: string }[];
      projects?: unknown[]; languages?: ({ name?: string } | string)[]; references?: unknown[];
      hiddenSections?: readonly string[];
    },
  posting: Pick<Posting, 'skills' | 'educationLevel' | 'minExperienceMonths' | 'weights'>
    & { certifications?: string[]; languages?: string[]; minProjects?: number; minReferences?: number },
): MatchResult {
  /* Applied here rather than left to each caller. Every screen that scores --
     browse, the dashboard, the recruiter's live simulation -- has to agree
     with the server, and a rule that depends on remembering to call a helper
     first is a rule that eventually is not applied somewhere. Idempotent, so
     a resume the server already stripped passes through unchanged. */
  resume = visibleResume(resume);
  const W = weightsFor(posting);
  const required = posting.skills || [];
  const have = new Set((resume.skills || []).map(normSkill));
  const matched = required.filter((s) => have.has(normSkill(s)));

  /* Evidence is keyed by the applicant's spelling, `matched` holds the
     posting's, so the lookup normalises both, the same way the match did.
     An ABSENT map means the question was never asked (an extracted document,
     not a built resume) and everything counts in full; an EMPTY one means it
     was asked and went unanswered. */
  const evidence = resume.skillEvidence;
  const evidenced = new Set<string>();
  if (evidence) {
    for (const [name, ev] of Object.entries(evidence)) if (evidenceSources(ev).length) evidenced.add(normSkill(name));
  }
  const unevidenced = evidence ? matched.filter((s) => !evidenced.has(normSkill(s))) : [];
  const credited = matched.length - unevidenced.length * (1 - UNEVIDENCED_CREDIT);
  const skillPart = required.length ? credited / required.length : 1;

  /* EDUCATION = LEVEL × RELEVANCE. The level is scored as it always was,
     your rank ÷ the rank asked for. The panel's revision adds what the
     degree is ABOUT: a degree in a field the opening accepts counts in full,
     one in another field counts at UNRELATED_CREDIT.

     Relevance applies only where it means something — when the opening asks
     for college AND the applicant has college. A high-school requirement has
     no field to be relevant to, and an applicant with no degree is already
     scored down by the level, so halving them again would count one gap
     twice. An opening that accepts any field (see acceptedFields) never
     halves anybody. */
  const seekerEdu = Math.max(0, ...(resume.education || []).map((e) => EDU_RANK[e.level] || 0));
  const reqEdu = EDU_RANK[posting.educationLevel] || 0;
  const levelPart = reqEdu === 0 ? 1 : Math.min(1, seekerEdu / reqEdu);

  const wantedFields = acceptedFields(posting);
  const seekerFields = educationFields(
    (resume.education || []).map((e: any) => `${e?.degree || ''} ${e?.field || ''}`).join(' '));
  const fieldMeets = wantedFields.size === 0
    || [...seekerFields].some((f) => wantedFields.has(f));
  const fieldApplies = reqEdu >= EDU_RANK['associate'] && seekerEdu >= EDU_RANK['associate'] && wantedFields.size > 0;
  const eduFieldRelated: boolean | null = fieldApplies ? fieldMeets : null;
  const eduPart = levelPart * (eduFieldRelated === false ? UNRELATED_CREDIT : 1);

  /* EXPERIENCE = CREDITED MONTHS ÷ MONTHS ASKED FOR. Every month still
     counts, but a month in a job relevant to this opening (see
     experienceRelevant) counts in full and any other month counts at
     UNRELATED_CREDIT — so nine months behind a counter meets a nine-month
     requirement halfway, and nine months at a help desk meets it fully. An
     opening asking for no experience still scores full marks. */
  const months = (resume.experience || []).reduce((t, e) => t + (Number(e.months) || 0), 0);
  const reqMonths = Number(posting.minExperienceMonths) || 0;
  const relevantMonths = (resume.experience || []).reduce(
    (t, e) => (experienceRelevant(e, posting, required) ? t + (Number(e?.months) || 0) : t), 0);
  const creditedMonths = relevantMonths + (months - relevantMonths) * UNRELATED_CREDIT;
  const expPart = reqMonths <= 0 ? 1 : Math.min(1, creditedMonths / reqMonths);

  /* CERTIFICATIONS — the optional fourth component. An opening asking for
     none scores full marks here, exactly as an unstated education or months
     requirement does. The weight defaults to 0, so this contributes nothing
     unless a recruiter deliberately gives it a share. */
  const wantCerts = posting.certifications || [];
  const haveCerts = (resume.certifications || [])
    .map((c) => normCert(c?.name ?? '')).filter(Boolean);
  const matchedCerts: string[] = [];
  const missingCerts: string[] = [];
  for (const want of wantCerts) {
    const w = normCert(want);
    (w && haveCerts.some((h) => h.includes(w)) ? matchedCerts : missingCerts).push(want);
  }
  const certPart = wantCerts.length ? matchedCerts.length / wantCerts.length : 1;

  /* LANGUAGES — matched by name, exactly as certifications are, because a
     language is something an opening either names or does not. An opening
     naming none scores full marks here. */
  const wantLangs = posting.languages || [];
  const haveLangs = (resume.languages || [])
    .map((l) => normCert(typeof l === 'string' ? l : (l?.name ?? ''))).filter(Boolean);
  const matchedLangs: string[] = [];
  const missingLangs: string[] = [];
  for (const want of wantLangs) {
    const w = normCert(want);
    (w && haveLangs.some((h) => h.includes(w)) ? matchedLangs : missingLangs).push(want);
  }
  const langPart = wantLangs.length ? matchedLangs.length / wantLangs.length : 1;

  /* PROJECTS and REFERENCES — counted against a stated minimum, the way months
     of experience are, capped at 1 so exceeding a requirement adds nothing. A
     minimum of zero means the opening stated none, which scores full marks. */
  const projectCount = (resume.projects || []).length;
  const minProjects = Math.max(0, Number(posting.minProjects) || 0);
  const projPart = minProjects <= 0 ? 1 : Math.min(1, projectCount / minProjects);

  const referenceCount = (resume.references || []).length;
  const minReferences = Math.max(0, Number(posting.minReferences) || 0);
  const refPart = minReferences <= 0 ? 1 : Math.min(1, referenceCount / minReferences);

  /* RELEVANT EXPERIENCE — the optional eighth component. Relevance already
     counts inside the experience component above; this slider is for a
     recruiter who wants it to count MORE — only relevant months, weighed on
     their own. Zero unless the recruiter gives it a share. Measured against
     the same requirement as the months, and an opening stating none scores
     full marks, the rule every other component follows. */
  const relPart = reqMonths <= 0 ? 1 : Math.min(1, relevantMonths / reqMonths);

  /* FIELD OF STUDY — the optional ninth component. The field already counts
     inside the education component above; this slider is for a recruiter who
     wants it to count MORE, all or nothing, and at any level. Zero unless the
     recruiter gives it a share. */
  const fieldPart = fieldMeets ? 1 : 0;

  const raw = (skillPart * W.skills + eduPart * W.education
    + expPart * W.experience + certPart * W.certifications
    + projPart * W.projects + langPart * W.languages + refPart * W.references
    + relPart * W.relevance + fieldPart * W.field) * 100;
  const total = Math.floor(raw + 0.5); // half-up, explicitly, must match server rmScore()

  return {
    score: total,
    matchedSkills: matched,
    missingSkills: required.filter((s) => !have.has(normSkill(s))),
    unevidencedMatches: unevidenced,
    totalSkills: required.length,
    eduMeets: eduPart >= 1,
    expMeets: expPart >= 1,
    seekerMonths: months,
    relevantMonths,
    creditedMonths,
    eduLevelMeets: levelPart >= 1,
    eduFieldRelated,
    fieldMeets,
    matchedCertifications: matchedCerts,
    missingCertifications: missingCerts,
    matchedLanguages: matchedLangs,
    missingLanguages: missingLangs,
    projectCount,
    minProjects,
    referenceCount,
    minReferences,
    tier: total >= THRESHOLDS.strong ? 'strong' : total >= THRESHOLDS.related ? 'possible' : 'related',
    weights: W,
  };
}

export function tierOf(n: number): Tier {
  return n >= THRESHOLDS.strong ? 'strong' : n >= THRESHOLDS.related ? 'possible' : 'related';
}
export function tierColor(n: number): string {
  const t = tierOf(n);
  return t === 'strong' ? 'var(--emerald)' : t === 'possible' ? 'var(--amber)' : 'var(--slate)';
}
export function tierLabel(n: number): string {
  const t = tierOf(n);
  return t === 'strong' ? 'Strong match' : t === 'possible' ? 'Possible match' : 'Related role';
}
export function statusBadge(s: AppStatus): string {
  return {
    submitted: 'slate',
    scheduling: 'amber', initial_interview: 'amber', testing: 'amber',
    shortlisted: 'green', final_interview: 'green', offer: 'green',
    hired: 'solid', rejected: 'wine', withdrawn: 'slate',
    review: 'amber', // legacy
  }[s] || 'slate';
}
