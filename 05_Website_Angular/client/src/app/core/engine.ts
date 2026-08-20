/* ============================================================
   Matching engine + shared constants, ported 1:1 from
   04_Website/app/assets/api.js (score(), WEIGHTS, THRESHOLDS, …)
   Used by demo mode directly, and by the builder/browse/hr-posting
   pages for instant client-side "how would this score" previews
   in BOTH modes (the API mode still calls the server for anything
   that must be authoritative, e.g. applying).
   ============================================================ */
import { AppStatus, EduLevel, EvidenceKind, MatchResult, Posting, RejectionReason, Resume, Tier } from './models';

/* The study's published defaults. The SERVER is the authority, it reads
   these from the match_settings table, so an admin can retune them without a
   redeploy. These objects are MUTATED (never reassigned) by applyMatchSettings()
   at startup in api mode, so every call site below keeps working while the
   live score a seeker sees stays equal to the score the server stores.
   Without that, editing match_settings would show the seeker one number and
   the recruiter another for the very same application. */
export const WEIGHTS = { skills: 0.5, education: 0.25, experience: 0.25 };
export const THRESHOLDS = { strong: 80, related: 50 };

/** Every accepted value of `resumes.design`. Anything else falls back to
 *  'classic' rather than being rejected, so a resume saved by a newer build
 *  still opens on an older one. Three places must agree with this list: the
 *  ResumeDesign union in models.ts, the whitelist in server routes/resumes.ts,
 *  and the CHECK constraint on the resumes table. */
export const DESIGNS: string[] = [
  'classic', 'modern', 'minimal', 'executive', 'banner', 'split', 'bar', 'categorized',
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
    if (sk !== null && ed !== null && ex !== null && sk >= 0 && ed >= 0 && ex >= 0) {
      WEIGHTS.skills = sk; WEIGHTS.education = ed; WEIGHTS.experience = ex;
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

export const EVIDENCE_KINDS: EvidenceKind[] = ['experience', 'project', 'certification', 'education'];

/** What each source type is called on screen. Kept apart from the stored
 *  value so the wording can be plain without changing what is saved. */
export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  experience:    'Work experience',
  project:       'Project',
  certification: 'Certification',
  education:     'Education',
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
  return String(e?.name ?? '').trim(); // project, certification
}

/** Every label on this resume a skill may point at, per kind. A source must
 *  be something already written down elsewhere on the same resume: that is
 *  the whole mechanism, and it is why this is a picker and not a text box. */
export function evidenceLabels(resume: {
  experience?: any[]; projects?: any[]; certifications?: any[]; education?: any[];
}): Record<EvidenceKind, Set<string>> {
  const set = (kind: EvidenceKind, rows: any[] | undefined) =>
    new Set((rows ?? []).map((e) => evidenceLabel(kind, e)).filter(Boolean));
  return {
    experience: set('experience', resume.experience),
    project: set('project', resume.projects),
    certification: set('certification', resume.certifications),
    education: set('education', resume.education),
  };
}

export const STATUS_LABELS: Record<AppStatus, string> = {
  submitted: 'Submitted', review: 'Under review', shortlisted: 'Shortlisted', rejected: 'Not selected', hired: 'Hired',
  withdrawn: 'Withdrawn',
};
/** The statuses a RECRUITER may set, in pipeline order. 'withdrawn' is
 *  deliberately absent: only the applicant can withdraw their own
 *  application, so it is never an option in a recruiter's status picker. */
export const STATUS_ORDER: AppStatus[] = ['submitted', 'review', 'shortlisted', 'rejected', 'hired'];

/* Every status a row can actually hold. Counts and breakdowns must use this
   one, building them from STATUS_ORDER left 'withdrawn' out entirely, so a
   withdrawn application simply vanished from the recruiter's totals. */
export const ALL_STATUSES: AppStatus[] = [...STATUS_ORDER, 'withdrawn'];

export const EDU_RANK: Record<EduLevel, number> = {
  none: 0, highschool: 1, vocational: 2, associate: 3, bachelor: 4, master: 5,
};
export const EDU_LABELS: Record<EduLevel, string> = {
  none: 'No requirement', highschool: 'High school', vocational: 'Vocational / TESDA',
  associate: 'Associate degree', bachelor: 'Bachelor’s degree', master: 'Master’s degree',
};

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
  // tech
  js: 'javascript', ecmascript: 'javascript',
  ts: 'typescript',
  html: 'htmlcss', css: 'htmlcss', htmlandcss: 'htmlcss', html5: 'htmlcss', css3: 'htmlcss',
  msoffice: 'microsoftoffice', microsoftofficesuite: 'microsoftoffice', officesuite: 'microsoftoffice',
  msexcel: 'excel', microsoftexcel: 'excel',
  msword: 'word', microsoftword: 'word',
  mssql: 'sql', sqlserver: 'sql', mysqldatabase: 'mysql',
  photoshop: 'adobephotoshop',
  troubleshoot: 'troubleshooting', technicalsupport: 'troubleshooting', techsupport: 'troubleshooting',
  networking: 'computernetworking', network: 'computernetworking',
  // outsourcing / back-office (the pilot partner's world)
  //
  // Every entry below is a genuine synonym or abbreviation of the term it maps
  // to. Deliberately absent: product names folded into categories. "Salesforce"
  // is not a synonym for "CRM Software", it is one particular CRM, equating
  // them would credit an applicant with a skill they did not claim, which the
  // Definition of Terms promises this vocabulary never does.
  customersupport: 'customerservice', clientservice: 'customerservice',
  clientsupport: 'customerservice', customercare: 'customerservice', csr: 'customerservice',
  crm: 'crmsoftware', crmsystem: 'crmsoftware', crmtools: 'crmsoftware',
  encoding: 'dataentry', dataencoding: 'dataentry',
  qb: 'quickbooks', quickbooksonline: 'quickbooks',
  bookkeeper: 'bookkeeping', bookkeepingsupport: 'bookkeeping',
  medicalterms: 'medicalterminology',
  detailoriented: 'attentiontodetail', attentiontodetails: 'attentiontodetail',
  // general
  communicationskills: 'communication', oralcommunication: 'communication',
  teamplayer: 'teamwork', collaboration: 'teamwork',
  timemanagementskills: 'timemanagement',
  problemsolvingskills: 'problemsolving',
  leadershipskills: 'leadership',
  english: 'englishproficiency', englishcommunication: 'englishproficiency',
  socmed: 'socialmedia', socialmediamanagement: 'socialmedia',
};

/* ------------------------------------------------------------
   SKILL CATEGORIES, keyed by the canonical normalised form, mirroring the
   `category` column of the seeded skills catalogue. An engine test reads
   db/resumematch_ph.sql and fails if the two disagree, so this stays a copy
   of the database rather than a second opinion about it.

   Used for ONE purpose: telling an applicant what KIND of requirement they
   have not met, without naming it. See missingHint() below for why that
   distinction exists.
   ------------------------------------------------------------ */
export type SkillCategory = 'technical' | 'soft';

export const SKILL_CATEGORY: Record<string, SkillCategory> = {
  htmlcss: 'technical', javascript: 'technical', git: 'technical',
  troubleshooting: 'technical', windows: 'technical', computernetworking: 'technical',
  crmsoftware: 'technical', canva: 'technical', copywriting: 'technical',
  dataentry: 'technical', quickbooks: 'technical', bookkeeping: 'technical',
  medicalterminology: 'technical', microsoftoffice: 'technical', socialmedia: 'technical',
  teamwork: 'soft', communication: 'soft', customerservice: 'soft',
  englishproficiency: 'soft', attentiontodetail: 'soft', organization: 'soft',
  recruitment: 'soft', scheduling: 'soft', leadership: 'soft', timemanagement: 'soft',
};

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
  if (w.skills + w.education + w.experience !== 100) return WEIGHTS;
  // Percentages in, fractions out, the same single conversion the server does.
  return { skills: w.skills / 100, education: w.education / 100, experience: w.experience / 100 };
}

export function scoreLocal(
  resume: Pick<Resume, 'skills' | 'education' | 'experience'> & { skillEvidence?: Resume['skillEvidence'] },
  posting: Pick<Posting, 'skills' | 'educationLevel' | 'minExperienceMonths' | 'weights'>,
): MatchResult {
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
    for (const [name, ev] of Object.entries(evidence)) if (ev?.ref) evidenced.add(normSkill(name));
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

  const raw = (skillPart * W.skills + eduPart * W.education + expPart * W.experience) * 100;
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
  return { submitted: 'slate', review: 'amber', shortlisted: 'green', hired: 'solid', rejected: 'wine', withdrawn: 'slate' }[s] || 'slate';
}
