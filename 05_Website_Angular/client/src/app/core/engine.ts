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
  certifications: 0, projects: 0, languages: 0, references: 0, relevance: 0,
};
export const THRESHOLDS = { strong: 80, related: 50 };

/** The optional components, in interface order. The browser's mirror of
 *  OPTIONAL_WEIGHTS in server/src/lib/engine.ts and it must stay identical:
 *  the two validators have to reject and accept exactly the same weight sets,
 *  or a posting the recruiter could save would score differently in the
 *  seeker's live preview than on the server. */
export const OPTIONAL_WEIGHTS = ['certifications', 'projects', 'languages', 'references', 'relevance'] as const;
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

/** Catalogue names grouped by industry, for a browsable picker. */
export const SKILL_BY_INDUSTRY: ReadonlyArray<readonly [string, readonly string[]]> =
  /* DERIVED from SKILL_CATALOGUE rather than written out again. It used to be
     a second hand-maintained copy of the same grouping, which meant adding a
     skill in one place and forgetting the other left the posting form quietly
     offering a different set than the catalogue held. Industries appear in
     the order the catalogue first mentions them, and the names within each
     stay in catalogue order. */
  (() => {
    const by = new Map<string, string[]>();
    for (const s of SKILL_CATALOGUE) {
      const list = by.get(s.industry);
      if (list) list.push(s.name); else by.set(s.industry, [s.name]);
    }
    return [...by].map(([industry, names]) => [industry, names] as const);
  })();

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

/** Normalize a skill to its canonical comparable form: strip case and
 *  punctuation, then fold known synonyms together. Used for BOTH sides
 *  of every comparison, so a resume and a posting that mean the same
 *  thing land on it. */
export function normSkill(s: string): string {
  const base = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return SKILL_ALIASES[base] ?? base;
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
    relevance: opt['relevance'] / 100,
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

  const seekerEdu = Math.max(0, ...(resume.education || []).map((e) => EDU_RANK[e.level] || 0));
  const reqEdu = EDU_RANK[posting.educationLevel] || 0;
  const eduPart = reqEdu === 0 ? 1 : Math.min(1, seekerEdu / reqEdu);

  const months = (resume.experience || []).reduce((t, e) => t + (Number(e.months) || 0), 0);
  const reqMonths = Number(posting.minExperienceMonths) || 0;
  const expPart = reqMonths <= 0 ? 1 : Math.min(1, months / reqMonths);

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

  /* RELEVANT EXPERIENCE — the optional eighth component.
   *
   * The experience component above counts months and nothing else: a year
   * behind a counter and a year at a help desk are the same number to it.
   * Four of the ten HR respondents said so independently, and the panel asked
   * for the job's title and description to be read rather than only its
   * length. This is that, kept separate from the months so the recruiter
   * decides how much it is worth.
   *
   * ZERO BY DEFAULT, like every optional component. That is deliberate and
   * load-bearing: at the default weight this contributes nothing and the
   * score is bit-for-bit the one every respondent in the evaluation rated.
   * A recruiter who wants relevance counted switches it on for their own
   * opening.
   *
   * Relevance is decided by THE SKILLS THE OPENING ALREADY ASKS FOR, read out
   * of the job's own title, description and bullets. No new vocabulary and no
   * similarity guessing: the same normSkill() the skills component uses, so a
   * recruiter can predict it and an applicant can be told why. */
  const relevantMonths = (resume.experience || []).reduce((t, e) => {
    const text = [e?.position, e?.description, ...(Array.isArray((e as any)?.bullets) ? (e as any).bullets : [])]
      .filter(Boolean).join(' ');
    return jobMentionsAny(text, required) ? t + (Number(e?.months) || 0) : t;
  }, 0);
  /* Measured against the SAME requirement the months are measured against, so
     the two components answer the same question and differ only in which
     months they are willing to count. An opening stating no requirement scores
     full marks here too — a requirement nobody set cannot be one the applicant
     failed, which is the rule every other component follows. */
  const relPart = reqMonths <= 0 ? 1 : Math.min(1, relevantMonths / reqMonths);

  const raw = (skillPart * W.skills + eduPart * W.education
    + expPart * W.experience + certPart * W.certifications
    + projPart * W.projects + langPart * W.languages + refPart * W.references
    + relPart * W.relevance) * 100;
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
