/* ============================================================
   MATCHING ENGINE — port of api/_lib.php rm_score(), which itself
   mirrors assets/api.js score(). Rule-based only — no ML, no AI.
   The applicant's uploaded file is scored by the SAME arithmetic, from
   fields a reader extracted out of it — see rmFileScore below.
   ============================================================ */
import { query, exec } from '../db';

/* WHY a recruiter moved an application, as a closed list.
   Free text would be unanalysable and would tempt a hurried recruiter into
   writing something the company would not want to stand behind; a code can be
   counted, and the study can report the distribution of outcomes without
   reading anybody's prose. Mirrored in client/src/app/core/engine.ts. */
export const REJECTION_REASONS = [
  'not_qualified', 'failed_requirement', 'salary_mismatch', 'unreachable',
  'position_filled', 'stronger_candidate', 'withdrew_interest', 'other',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/* EVIDENCE-LINKED SKILLS

   A skill on a resume is a claim, and treating every claim alike is what made
   the ranking gameable: a posting publishes the skills it wants, and anyone
   can type those exact words minutes before applying. So the builder asks
   where the skill was used, and the answer must point at an entry already on
   the resume — a job, project, certification or course. It cannot be free
   text, so padding now means also inventing the job it came from.

   Two rules, both chosen over stricter alternatives:

     · A skill WITHOUT a source still counts, at UNEVIDENCED_CREDIT. Plenty of
       real skills are self-taught or from work too small to list, and refusing
       them would punish exactly the applicants this study is for.
     · The link is NEVER printed on the resume, so no ATS parser and none of
       the fourteen designs are affected. Only the recruiter's view shows it.

   This reduces the payoff for padding, it does not remove it: on a four-skill
   opening, one real skill plus three typed moves 63 to 81, not 63 to 100. What
   stops padding after applying is the score snapshot in routes/applications.ts. */
/* 'document' is the applicant's own uploaded file. It is a source in the same
   sense as the others — it points at something already ON the resume, which a
   recruiter can open and read — and it exists because the skills read out of a
   CV came from that document rather than being typed against a posting. Without
   it an imported resume looked like an applicant who had been asked where each
   skill was used and declined for every one. */
export const EVIDENCE_KINDS = ['experience', 'project', 'certification', 'education', 'document'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export interface SkillEvidence {
  kind: EvidenceKind;
  /** The label of the entry it points at, as the applicant wrote it. */
  ref: string;
}
/** A skill's evidence is a LIST of sources — a skill can be learned in more
 *  than one place (a job and a school). Older resumes stored a single source
 *  as one object; this normalises both shapes to a list, dropping anything
 *  with no ref. Scoring only asks "is the list non-empty?" — more than one
 *  source never lifts a skill above full credit; it only records where it came
 *  from for the recruiter to read. */
export function evidenceSources(ev: SkillEvidence | SkillEvidence[] | null | undefined): SkillEvidence[] {
  if (!ev) return [];
  return (Array.isArray(ev) ? ev : [ev]).filter((s) => s && s.ref);
}

/** What a matched skill is worth when the applicant named no source for it.
 *
 *  Half, and the value is published rather than tuned: "a skill you can point
 *  to evidence for counts fully; one you cannot counts half" is a sentence an
 *  applicant can be told and a recruiter can repeat. A smaller number scores
 *  closer to calling an unsourced skill a lie, which it is not. */
export const UNEVIDENCED_CREDIT = 0.5;

/** How one resume entry is labelled when it is offered as a source, and when
 *  a stored source is checked back against the resume.
 *
 *  Mirrored in client/src/app/core/engine.ts and covered by the parity test.
 *  The two must agree exactly: the builder offers these strings, the server
 *  accepts only these strings, and a mismatch would look to the applicant
 *  like the source they picked had been thrown away. */
export function evidenceLabel(kind: EvidenceKind, e: any): string {
  const join = (a: unknown, b: unknown) => [String(a ?? '').trim(), String(b ?? '').trim()].filter(Boolean).join(', ');
  if (kind === 'experience') return join(e?.position, e?.company);
  if (kind === 'education') return join(e?.degree, e?.school);
  return String(e?.name ?? '').trim(); // project, certification, document
}

/** Every label on this resume that a skill is allowed to point at, per kind.
 *
 *  A source has to be something the applicant already wrote down elsewhere.
 *  That is the whole mechanism: free text would let the skill and its
 *  justification be invented in the same keystroke, which is precisely the
 *  padding this feature is meant to make expensive. */
export function evidenceLabels(resume: {
  experience?: any[]; projects?: any[]; certifications?: any[]; education?: any[];
  ownFile?: { name?: string } | null;
}): Record<EvidenceKind, Set<string>> {
  const set = (kind: EvidenceKind, rows: any[] | undefined) =>
    new Set((rows ?? []).map((e) => evidenceLabel(kind, e)).filter(Boolean));
  /* The document is valid as a source only while it is actually attached. A
     resume whose file is removed loses those links on its next save, exactly
     as renaming a job loses the links pointing at it. */
  const file = String(resume.ownFile?.name ?? '').trim();
  return {
    experience: set('experience', resume.experience),
    project: set('project', resume.projects),
    certification: set('certification', resume.certifications),
    education: set('education', resume.education),
    document: new Set(file ? [file] : []),
  };
}

export const EDU_RANK: Record<string, number> = {
  // Mirrors client engine.ts. 'college_level' is undergraduate/some-college,
  // ranked between associate and bachelor at 3.5 so no existing whole-number
  // rank (or the ratios built from them) changes.
  none: 0, highschool: 1, vocational: 2, associate: 3, college_level: 3.5, bachelor: 4, master: 5,
};

/* ------------------------------------------------------------
   SKILL ALIASES — mirrored 1:1 in client/src/app/core/engine.ts.

   Without this, matching is literal: a seeker who writes "JS" gets
   zero credit for a posting asking for "JavaScript", and "MS Office"
   never matches "Microsoft Office". That is a false negative created
   purely by vocabulary, which is the exact unfairness this project
   argues against — so equivalent terms are folded to one canonical
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

/** Normalize a skill to its canonical comparable form: strip case and
 *  punctuation, then fold known synonyms together. Used for BOTH sides
 *  of every comparison, and for the canonical `skills.skill_norm` row,
 *  so a resume and a posting that mean the same thing land on it. */
export function skillNorm(s: string): string {
  const base = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return SKILL_ALIASES[base] ?? base;
}

/** Does this job's own words mention any of the skills the opening asks for?
 *  The browser's mirror of jobMentionsAny() in client/src/app/core/engine.ts
 *  and it must stay identical — the two implementations score the same
 *  application and parity asserts they agree.
 *
 *  Words, not substrings: a plain indexOf would find "git" inside "digital".
 *  Runs of one to four consecutive words are put through skillNorm(), so
 *  multi-word skills are found and the ONE alias table decides synonyms. A
 *  skill the vocabulary does not know simply fails to match, costing credit
 *  rather than awarding it wrongly. */
export function jobMentionsAny(text: string, skills: readonly string[]): boolean {
  if (!text || !skills.length) return false;
  const wanted = new Set(skills.map(skillNorm).filter(Boolean));
  if (!wanted.size) return false;
  const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      if (wanted.has(skillNorm(words.slice(i, i + n).join(' ')))) return true;
    }
  }
  return false;
}

/** The seven components a score can be built from, as FRACTIONS summing to 1.
 *
 *  Only the first three are compulsory. The four after them each default to 0,
 *  which is what keeps the site-wide split at the study's published 50/25/25
 *  across three unless a recruiter deliberately gives one of the others a
 *  share on their own opening — and what lets every opening written before a
 *  component existed keep producing exactly the score it always has. */
export interface Weights {
  skills: number;
  education: number;
  experience: number;
  certifications: number;
  projects: number;
  languages: number;
  references: number;
  /** Months counted only from a job whose own words mention a required
   *  skill. Zero unless a recruiter deliberately gives it a share. */
  relevance: number;
}

/** The optional components, in the order the interface presents them. Listing
 *  them once stops the validator, the defaults and the DB reader from drifting
 *  apart as the set grows. */
export const OPTIONAL_WEIGHTS = ['certifications', 'projects', 'languages', 'references', 'relevance'] as const;
/** The three a recruiter may de-emphasise but never switch off. */
export const CORE_WEIGHTS = ['skills', 'education', 'experience'] as const;
/** No component may fall below this share, for the three that are compulsory. */
export const WEIGHT_FLOOR = 10;

export interface MatchSettings {
  weights: Weights;
  thresholds: { strong: number; related: number };
}

let cachedSettings: MatchSettings | null = null;
let cachedAt = 0;
/* Cached, but not forever. The whole point of holding the weights in a table
   is that they can be retuned during testing; a permanent cache would have
   meant a process restart before an edit took effect, and two processes
   started at different times could serve different weights at once. */
const SETTINGS_TTL_MS = 60_000;

/** Weights and thresholds come from the DB, so "refined iteratively"
 *  means editing a row — not redeploying code. */
export async function getSettings(): Promise<MatchSettings> {
  if (cachedSettings && Date.now() - cachedAt < SETTINGS_TTL_MS) return cachedSettings;
  const rows = await query<{ setting_key: string; setting_value: string }>(
    'SELECT setting_key, setting_value FROM match_settings',
  );
  const map: Record<string, number> = {};
  for (const r of rows) map[r.setting_key] = Number(r.setting_value);
  /* A non-numeric or missing row must fall back to the published default,
     never to NaN: the thresholds are interpolated into the metrics query, so
     a NaN there produced invalid SQL and — before the async-router fix —
     took the process down with it. */
  const n = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  cachedSettings = {
    weights: {
      skills: n(map.weight_skills, DEFAULT_SETTINGS.weights.skills),
      education: n(map.weight_education, DEFAULT_SETTINGS.weights.education),
      experience: n(map.weight_experience, DEFAULT_SETTINGS.weights.experience),
      certifications: n(map.weight_certifications, DEFAULT_SETTINGS.weights.certifications),
      projects: n(map.weight_projects, DEFAULT_SETTINGS.weights.projects),
      languages: n(map.weight_languages, DEFAULT_SETTINGS.weights.languages),
      references: n(map.weight_references, DEFAULT_SETTINGS.weights.references),
      relevance: n(map.weight_relevance, DEFAULT_SETTINGS.weights.relevance),
    },
    thresholds: {
      strong: n(map.threshold_strong, DEFAULT_SETTINGS.thresholds.strong),
      related: n(map.threshold_related, DEFAULT_SETTINGS.thresholds.related),
    },
  };
  cachedAt = Date.now();
  return cachedSettings;
}

export interface SerializedResume {
  id: string;
  userId?: string;
  skills: string[];
  education: { level: string }[];
  experience: { months: number }[];
  /** Where each skill was used, keyed by the skill as the applicant wrote it.
   *
   *  ABSENT and EMPTY mean different things and the engine treats them
   *  differently. An empty object means the applicant was asked and named no
   *  sources, so their matched skills take partial credit. Absent means the
   *  question was never put — the only caller in that position is
   *  rmFileScore, scoring a document a machine read, where there was no
   *  builder to ask in. Penalising that would be scoring the applicant for a
   *  screen they were never shown. */
  skillEvidence?: Record<string, SkillEvidence | SkillEvidence[]>;
  /** Only read when the opening asks for certifications. Free text, as the
   *  applicant typed it — there is no catalogue for these the way there is
   *  for skills. */
  certifications?: { name?: string }[];
  /** Read only when the opening gives the matching component a share.
   *  Projects and references are COUNTED against a stated minimum, the way
   *  months of experience are; languages are MATCHED by name, the way
   *  certifications are. */
  projects?: unknown[];
  languages?: ({ name?: string } | string)[];
  references?: unknown[];
  [k: string]: any;
}
export interface SerializedPosting {
  id: string;
  skills: string[];
  educationLevel: string;
  minExperienceMonths: number;
  /** The certifications this opening asks for, free text. Empty or absent
   *  means it asks for none, which scores full marks on that component in
   *  the same way an unstated education or experience requirement does. */
  certifications?: string[];
  /** This opening's own weights as WHOLE PERCENTAGES totalling 100. Absent
   *  or null means the opening inherits the site defaults.
   *
   *  `certifications` is optional and treated as 0 when missing, which is
   *  what lets an opening written before the fourth component existed keep
   *  summing to 100 without a backfill. */
  weights?: ({ skills: number; education: number; experience: number }
    & Partial<Record<typeof OPTIONAL_WEIGHTS[number], number>>) | null;
  /** The languages this opening asks for, free text, matched the way
   *  certifications are. Empty or absent means it asks for none, which scores
   *  full marks on that component. */
  languages?: string[];
  /** Minimum counts for the two sections scored like experience. 0 or absent
   *  means the opening states no requirement, which contributes a full
   *  component rather than a penalty. */
  minProjects?: number;
  minReferences?: number;
  [k: string]: any;
}

/** The weights one POSTING is scored with.
 *
 *  A posting that names its own overrides the site defaults; one that does not
 *  inherits them, so retuning match_settings still moves every opening that
 *  never customised — which is how the study's weights were meant to be
 *  refined, and stays true now that recruiters can opt out of them.
 *
 *  A malformed or partial set is REJECTED WHOLESALE rather than repaired.
 *  Normalising 40/40/40 to sum to 1 would score every applicant on a scale
 *  the recruiter never chose and nothing downstream would look wrong; falling
 *  back to the published defaults is at least a number the site can explain. */
/** Certifications are free text — there is no catalogue for them the way
 *  there is for skills, because a certificate's name is whatever the body
 *  that issued it calls it. So the comparison is deliberately forgiving in
 *  one direction only: the applicant's entry must CONTAIN what the opening
 *  asked for, once both are reduced to lowercase alphanumerics. That way
 *  "Cisco CCNA Routing and Switching" answers a request for "CCNA", while
 *  "CCNA" alone does not answer a request for something longer and more
 *  specific. Nothing is guessed at, and nothing is credited that was not
 *  claimed. */
export function certNorm(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Fill in any component the caller left out.
 *
 *  A settings object can legitimately carry fewer than seven weights: one
 *  built by hand, or read from a match_settings table written before a
 *  component existed. Multiplying by an absent weight would produce NaN and
 *  take the entire score down with it — silently, because NaN compares false
 *  against every threshold and simply reports as the bottom tier. So every
 *  optional component reads as 0 when missing, and the three compulsory ones
 *  fall back to the published defaults. */
export function fillWeights(w: Partial<Weights> | null | undefined): Weights {
  const n = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  const d = DEFAULT_SETTINGS.weights;
  return {
    skills: n(w?.skills, d.skills),
    education: n(w?.education, d.education),
    experience: n(w?.experience, d.experience),
    certifications: n(w?.certifications, 0),
    relevance: n(w?.relevance, 0),
    projects: n(w?.projects, 0),
    languages: n(w?.languages, 0),
    references: n(w?.references, 0),
  };
}

export function weightsFor(cfg: MatchSettings, posting: SerializedPosting): Weights {
  const w = posting.weights;
  if (!w) return fillWeights(cfg.weights);
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!ok(w.skills) || !ok(w.education) || !ok(w.experience)) return fillWeights(cfg.weights);
  /* Absent means zero, not invalid. An opening written before a component was
     scoreable carries only the weights that existed then, and must keep the
     score it has always produced — which is why every optional component is
     read through this coalesce rather than required to be present. */
  const opt: Record<string, number> = {};
  for (const k of OPTIONAL_WEIGHTS) {
    const v = (w as Record<string, unknown>)[k];
    const n = v === undefined || v === null ? 0 : v;
    if (!ok(n)) return fillWeights(cfg.weights);
    opt[k] = n;
  }
  const total = w.skills + w.education + w.experience
    + OPTIONAL_WEIGHTS.reduce((s, k) => s + opt[k], 0);
  if (total !== 100) return fillWeights(cfg.weights);
  // Percentages in, fractions out — the single conversion point in the system.
  return {
    skills: w.skills / 100, education: w.education / 100, experience: w.experience / 100,
    certifications: opt.certifications / 100, projects: opt.projects / 100,
    languages: opt.languages / 100, references: opt.references / 100,
    relevance: opt.relevance / 100,
  };
}

export interface MatchResult {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  /** Of the matched skills, the ones the applicant named no source for —
   *  each counted at UNEVIDENCED_CREDIT rather than in full. Always empty
   *  when evidence does not apply, which is why the applicant's uploaded
   *  file never shows an unsourced skill it was never asked about. */
  unevidencedMatches: string[];
  totalSkills: number;
  eduMeets: boolean;
  expMeets: boolean;
  seekerMonths: number;
  /** Months from jobs whose own words mention a required skill. */
  relevantMonths: number;
  tier: 'strong' | 'possible' | 'related';
  /** The weights this score was actually computed with, as fractions.
   *
   *  Carried on the result rather than looked up again by whoever displays
   *  it. The site tells the applicant "the formula is published, not hidden —
   *  you see exactly what the recruiter sees", and now that each opening can
   *  set its own split, honouring that means the number and the scale it came
   *  from have to travel together. A screen that fetched the weights
   *  separately could show a breakdown that does not add up to the score
   *  beside it. */
  weights: Weights;
  /** Of the certifications the opening asked for, the ones the applicant
   *  lists and the ones they do not. Both empty when none were asked for. */
  matchedCertifications: string[];
  missingCertifications: string[];
  /** Of the languages the opening asked for, the ones the applicant lists and
   *  the ones they do not. Both empty when none were asked for. */
  matchedLanguages: string[];
  missingLanguages: string[];
  /** How many projects and references the applicant has, beside the minimum
   *  the opening asked for. A minimum of 0 means none was stated, which the
   *  score treats as met in full. */
  projectCount: number;
  minProjects: number;
  referenceCount: number;
  minReferences: number;
}

/** The defaults used when the match_settings table has no overrides —
 *  the study's published 50/25/25 weights and 80/50 tier thresholds. */
export const DEFAULT_SETTINGS: MatchSettings = {
  weights: {
    skills: 0.5, education: 0.25, experience: 0.25,
    certifications: 0, projects: 0, languages: 0, references: 0, relevance: 0,
  },
  thresholds: { strong: 80, related: 50 },
};

/** The pure scoring function — no database, no I/O. rmScore() wraps it
 *  with the DB-loaded settings; the test suite calls it directly. */
export function scoreWith(cfg: MatchSettings, resume: SerializedResume, posting: SerializedPosting): MatchResult {
  /* Resolved from the POSTING first, the site defaults second. Doing it here
     rather than at each call site is what keeps rmScore, rmFileScore, the
     browser's live preview and the demo adapter from disagreeing about what
     an opening is worth. */
  const W = weightsFor(cfg, posting);
  const T = cfg.thresholds;

  const required = posting.skills || [];
  const have = new Set((resume.skills || []).map(skillNorm));
  const matched: string[] = [];
  const missing: string[] = [];
  for (const s of required) (have.has(skillNorm(s)) ? matched : missing).push(s);

  /* Evidence is keyed by the skill as the APPLICANT wrote it; `matched` holds
     the skill as the POSTING wrote it. They are the same skill and often not
     the same string ("JS" against "JavaScript"), so the lookup goes through
     the same normalisation the match itself did. */
  const evidence = resume.skillEvidence;
  const evidenced = new Set<string>();
  if (evidence) {
    for (const [name, ev] of Object.entries(evidence)) if (evidenceSources(ev).length) evidenced.add(skillNorm(name));
  }
  /* An ABSENT map means the question was never asked (see SerializedResume),
     so every match counts in full and nothing is reported as unsourced. */
  const unevidenced = evidence ? matched.filter((s) => !evidenced.has(skillNorm(s))) : [];
  const credited = matched.length - unevidenced.length * (1 - UNEVIDENCED_CREDIT);
  const skillPart = required.length ? credited / required.length : 1.0;

  let seekerEdu = 0;
  for (const e of resume.education || []) seekerEdu = Math.max(seekerEdu, EDU_RANK[e.level] ?? 0);
  const reqEdu = EDU_RANK[posting.educationLevel] ?? 0;
  const eduPart = reqEdu === 0 ? 1.0 : Math.min(1.0, seekerEdu / reqEdu);

  let months = 0;
  for (const e of resume.experience || []) months += Number(e.months) || 0;
  const reqMonths = Number(posting.minExperienceMonths) || 0;
  const expPart = reqMonths <= 0 ? 1.0 : Math.min(1.0, months / reqMonths);

  /* CERTIFICATIONS — the optional fourth component. An opening that asks for
     none scores full marks here, exactly as an unstated education or months
     requirement does: a requirement nobody stated cannot be one the applicant
     failed. That matters, because the weight defaults to zero, so this term
     contributes nothing at all unless a recruiter deliberately gives it a
     share. */
  const wantCerts = posting.certifications || [];
  const haveCerts = (resume.certifications || [])
    .map((c) => certNorm(c?.name ?? '')).filter(Boolean);
  const matchedCerts: string[] = [];
  const missingCerts: string[] = [];
  for (const want of wantCerts) {
    const w = certNorm(want);
    (w && haveCerts.some((h) => h.includes(w)) ? matchedCerts : missingCerts).push(want);
  }
  const certPart = wantCerts.length ? matchedCerts.length / wantCerts.length : 1.0;

  /* LANGUAGES — matched by name, exactly as certifications are, and for the
     same reason: a language is something an opening either names or does not,
     with no catalogue to normalise against the way skills have. An opening
     naming none scores full marks here. */
  const wantLangs = posting.languages || [];
  const haveLangs = (resume.languages || [])
    .map((l) => certNorm(typeof l === 'string' ? l : (l?.name ?? ''))).filter(Boolean);
  const matchedLangs: string[] = [];
  const missingLangs: string[] = [];
  for (const want of wantLangs) {
    const w = certNorm(want);
    (w && haveLangs.some((h) => h.includes(w)) ? matchedLangs : missingLangs).push(want);
  }
  const langPart = wantLangs.length ? matchedLangs.length / wantLangs.length : 1.0;

  /* PROJECTS and REFERENCES — counted against a stated minimum, the way months
     of experience are, and capped at 1.0 for the same reason: exceeding a
     requirement neither adds nor subtracts credit. A minimum of zero means the
     opening stated none, which contributes a full component rather than a
     penalty — a requirement nobody set cannot be one the applicant failed. */
  const projectCount = (resume.projects || []).length;
  const minProjects = Math.max(0, Number(posting.minProjects) || 0);
  const projPart = minProjects <= 0 ? 1.0 : Math.min(1.0, projectCount / minProjects);

  const referenceCount = (resume.references || []).length;
  const minReferences = Math.max(0, Number(posting.minReferences) || 0);
  const refPart = minReferences <= 0 ? 1.0 : Math.min(1.0, referenceCount / minReferences);

  /* RELEVANT EXPERIENCE — the optional eighth component, mirroring
     client/src/app/core/engine.ts. Months counted only from a job whose own
     title, description or bullets mention a skill this opening asks for.

     ZERO BY DEFAULT, and that is load-bearing rather than tidy: at the
     default weight it contributes nothing, so the score is bit-for-bit the
     one every respondent in the evaluation rated. A recruiter who wants
     relevance counted switches it on for their own opening. */
  const relevantMonths = (resume.experience || []).reduce((t: number, e: any) => {
    const text = [e?.position, e?.description, ...(Array.isArray(e?.bullets) ? e.bullets : [])]
      .filter(Boolean).join(' ');
    return jobMentionsAny(text, required) ? t + (Number(e?.months) || 0) : t;
  }, 0);
  /* Measured against the SAME requirement as the months above, so the two
     components differ only in which months they are willing to count. An
     opening stating no requirement scores full marks, the rule every other
     component follows. */
  const relPart = reqMonths <= 0 ? 1.0 : Math.min(1.0, relevantMonths / reqMonths);

  const raw = (skillPart * W.skills + eduPart * W.education
    + expPart * W.experience + certPart * W.certifications
    + projPart * W.projects + langPart * W.languages + refPart * W.references
    + relPart * W.relevance) * 100;
  const total = Math.floor(raw + 0.5); // half-up, explicitly — must match assets/api.js score()

  return {
    score: total,
    matchedSkills: matched,
    missingSkills: missing,
    unevidencedMatches: unevidenced,
    totalSkills: required.length,
    eduMeets: eduPart >= 1.0,
    expMeets: expPart >= 1.0,
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
    tier: total >= T.strong ? 'strong' : total >= T.related ? 'possible' : 'related',
    weights: W,
  };
}

export async function rmScore(resume: SerializedResume, posting: SerializedPosting): Promise<MatchResult> {
  return scoreWith(await getSettings(), resume, posting);
}

/** The score of the applicant's OWN uploaded document, when it could be read.
 *
 *  Same engine, same weights, same arithmetic as the resume built here — the
 *  only difference is where the skills, education level and months came from:
 *  a machine reading a document, rather than the applicant typing them in.
 *  That difference is exactly why this is reported SEPARATELY rather than
 *  replacing the score, and why the interface labels it as read by software.
 *
 *  Returns null when there is nothing to score, which is not the same as
 *  scoring zero and must never be displayed as though it were. */
export async function rmFileScore(
  extract: {
    skills?: string[]; education?: any[]; experience?: any[]; certifications?: any[];
    projects?: any[]; languages?: any[]; references?: any[];
  } | null | undefined,
  posting: SerializedPosting,
): Promise<MatchResult | null> {
  if (!extract) return null;
  return scoreWith(await getSettings(), {
    skills: Array.isArray(extract.skills) ? extract.skills : [],
    education: Array.isArray(extract.education) ? extract.education : [],
    experience: Array.isArray(extract.experience) ? extract.experience : [],
    certifications: Array.isArray(extract.certifications) ? extract.certifications : [],
    projects: Array.isArray(extract.projects) ? extract.projects : [],
    languages: Array.isArray(extract.languages) ? extract.languages : [],
    references: Array.isArray(extract.references) ? extract.references : [],
  } as SerializedResume, posting);
}

/** Cache a computed score so the study can report on it later. */
export async function cacheScore(resumeId: number, postingId: number, s: MatchResult): Promise<void> {
  await query(
    `INSERT INTO match_scores (resume_id, posting_id, compatibility_score, skills_matched, skills_required, edu_meets, exp_meets)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (resume_id, posting_id) DO UPDATE SET
       compatibility_score = EXCLUDED.compatibility_score, skills_matched = EXCLUDED.skills_matched,
       skills_required = EXCLUDED.skills_required, edu_meets = EXCLUDED.edu_meets, exp_meets = EXCLUDED.exp_meets,
       computed_at = now()`,
    [resumeId, postingId, s.score, s.matchedSkills.length, s.totalSkills, s.eduMeets ? 1 : 0, s.expMeets ? 1 : 0],
  );
}

/* ============================================================
   SKILLS — one canonical row per skill, so "MySQL" on a resume
   and "MySQL" on a posting are literally the same row.
   ============================================================ */
export async function skillId(name: string): Promise<number> {
  const trimmed = name.trim();
  const norm = skillNorm(trimmed);
  const rows = await query<{ skill_id: number }>('SELECT skill_id FROM skills WHERE skill_norm = ? LIMIT 1', [norm]);
  if (rows.length) return rows[0].skill_id;
  // ON CONFLICT covers the race where two requests insert the same skill
  // at once; the DO UPDATE (a no-op touch) makes RETURNING fire either way.
  const result = await exec(
    `INSERT INTO skills (skill_name, skill_norm) VALUES (?,?)
     ON CONFLICT (skill_norm) DO UPDATE SET skill_name = skills.skill_name
     RETURNING skill_id`,
    [trimmed, norm],
  );
  return result.insertId;
}
