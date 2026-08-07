/* ============================================================
   Matching engine + shared constants — ported 1:1 from
   04_Website/app/assets/api.js (score(), WEIGHTS, THRESHOLDS, …)
   Used by demo mode directly, and by the builder/browse/hr-posting
   pages for instant client-side "how would this score" previews
   in BOTH modes (the API mode still calls the server for anything
   that must be authoritative, e.g. applying).
   ============================================================ */
import { AppStatus, EduLevel, MatchResult, Posting, Resume, Tier } from './models';

/* The study's published defaults. The SERVER is the authority — it reads
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
    // All three or none — a partial set would silently change the total scale.
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

export const STATUS_LABELS: Record<AppStatus, string> = {
  submitted: 'Submitted', review: 'Under review', shortlisted: 'Shortlisted', rejected: 'Not selected', hired: 'Hired',
  withdrawn: 'Withdrawn',
};
/** The statuses a RECRUITER may set, in pipeline order. 'withdrawn' is
 *  deliberately absent: only the applicant can withdraw their own
 *  application, so it is never an option in a recruiter's status picker. */
export const STATUS_ORDER: AppStatus[] = ['submitted', 'review', 'shortlisted', 'rejected', 'hired'];

/* Every status a row can actually hold. Counts and breakdowns must use this
   one — building them from STATUS_ORDER left 'withdrawn' out entirely, so a
   withdrawn application simply vanished from the recruiter's totals. */
export const ALL_STATUSES: AppStatus[] = [...STATUS_ORDER, 'withdrawn'];

export const EDU_RANK: Record<EduLevel, number> = {
  none: 0, highschool: 1, vocational: 2, associate: 3, bachelor: 4, master: 5,
};
export const EDU_LABELS: Record<EduLevel, string> = {
  none: 'No requirement', highschool: 'High school', vocational: 'Vocational / TESDA',
  associate: 'Associate degree', bachelor: 'Bachelor’s degree', master: 'Master’s degree',
};

/** Password rule for anything that SETS a password — mirrored in
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
   SKILL ALIASES — mirrored 1:1 in server/src/lib/engine.ts.

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
  // is not a synonym for "CRM Software", it is one particular CRM — equating
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
export function scoreLocal(resume: Pick<Resume, 'skills' | 'education' | 'experience'>, posting: Pick<Posting, 'skills' | 'educationLevel' | 'minExperienceMonths'>): MatchResult {
  const required = posting.skills || [];
  const have = new Set((resume.skills || []).map(normSkill));
  const matched = required.filter((s) => have.has(normSkill(s)));
  const skillPart = required.length ? matched.length / required.length : 1;

  const seekerEdu = Math.max(0, ...(resume.education || []).map((e) => EDU_RANK[e.level] || 0));
  const reqEdu = EDU_RANK[posting.educationLevel] || 0;
  const eduPart = reqEdu === 0 ? 1 : Math.min(1, seekerEdu / reqEdu);

  const months = (resume.experience || []).reduce((t, e) => t + (Number(e.months) || 0), 0);
  const reqMonths = Number(posting.minExperienceMonths) || 0;
  const expPart = reqMonths <= 0 ? 1 : Math.min(1, months / reqMonths);

  const raw = (skillPart * WEIGHTS.skills + eduPart * WEIGHTS.education + expPart * WEIGHTS.experience) * 100;
  const total = Math.floor(raw + 0.5); // half-up, explicitly — must match server rmScore()

  return {
    score: total,
    matchedSkills: matched,
    missingSkills: required.filter((s) => !have.has(normSkill(s))),
    totalSkills: required.length,
    eduMeets: eduPart >= 1,
    expMeets: expPart >= 1,
    seekerMonths: months,
    tier: total >= THRESHOLDS.strong ? 'strong' : total >= THRESHOLDS.related ? 'possible' : 'related',
  };
}

export function tierOf(n: number): Tier {
  return n >= THRESHOLDS.strong ? 'strong' : n >= THRESHOLDS.related ? 'possible' : 'related';
}
export function tierColor(n: number): string {
  const t = tierOf(n);
  return t === 'strong' ? 'var(--emerald)' : t === 'possible' ? 'var(--gold)' : 'var(--slate)';
}
export function tierLabel(n: number): string {
  const t = tierOf(n);
  return t === 'strong' ? 'Strong match' : t === 'possible' ? 'Possible match' : 'Related role';
}
export function statusBadge(s: AppStatus): string {
  return { submitted: 'slate', review: 'gold', shortlisted: 'green', hired: 'solid', rejected: 'wine', withdrawn: 'slate' }[s] || 'slate';
}
