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
 *  of every comparison, and for the canonical `skills.skill_norm` row,
 *  so a resume and a posting that mean the same thing land on it. */
export function skillNorm(s: string): string {
  const base = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return SKILL_ALIASES[base] ?? base;
}

export interface MatchSettings {
  /** `certifications` is the optional fourth component and defaults to 0, so
   *  the site-wide split stays the study's published 50/25/25 across three
   *  unless a recruiter gives certifications a share on their own opening. */
  weights: { skills: number; education: number; experience: number; certifications: number };
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
  weights?: { skills: number; education: number; experience: number; certifications?: number } | null;
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

export function weightsFor(cfg: MatchSettings, posting: SerializedPosting): MatchSettings['weights'] {
  const w = posting.weights;
  if (!w) return cfg.weights;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!ok(w.skills) || !ok(w.education) || !ok(w.experience)) return cfg.weights;
  /* Absent means zero, not invalid. An opening written before certifications
     were scoreable carries three weights totalling 100, and must keep the
     score it has always produced. */
  const cert = w.certifications === undefined || w.certifications === null ? 0 : w.certifications;
  if (!ok(cert)) return cfg.weights;
  if (w.skills + w.education + w.experience + cert !== 100) return cfg.weights;
  // Percentages in, fractions out — the single conversion point in the system.
  return {
    skills: w.skills / 100, education: w.education / 100,
    experience: w.experience / 100, certifications: cert / 100,
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
  weights: { skills: number; education: number; experience: number; certifications: number };
  /** Of the certifications the opening asked for, the ones the applicant
   *  lists and the ones they do not. Both empty when none were asked for. */
  matchedCertifications: string[];
  missingCertifications: string[];
}

/** The defaults used when the match_settings table has no overrides —
 *  the study's published 50/25/25 weights and 80/50 tier thresholds. */
export const DEFAULT_SETTINGS: MatchSettings = {
  weights: { skills: 0.5, education: 0.25, experience: 0.25, certifications: 0 },
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

  const raw = (skillPart * W.skills + eduPart * W.education
    + expPart * W.experience + certPart * W.certifications) * 100;
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
    matchedCertifications: matchedCerts,
    missingCertifications: missingCerts,
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
  extract: { skills?: string[]; education?: any[]; experience?: any[]; certifications?: any[] } | null | undefined,
  posting: SerializedPosting,
): Promise<MatchResult | null> {
  if (!extract) return null;
  return scoreWith(await getSettings(), {
    skills: Array.isArray(extract.skills) ? extract.skills : [],
    education: Array.isArray(extract.education) ? extract.education : [],
    experience: Array.isArray(extract.experience) ? extract.experience : [],
    certifications: Array.isArray(extract.certifications) ? extract.certifications : [],
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
