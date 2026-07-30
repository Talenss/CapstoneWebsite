/* ============================================================
   MATCHING ENGINE — port of api/_lib.php rm_score(), which itself
   mirrors assets/api.js score(). Rule-based only — no ML, no AI.
   The applicant's uploaded file is scored by the SAME arithmetic, from
   fields a reader extracted out of it — see rmFileScore below.
   ============================================================ */
import { query, exec } from '../db';

export const EDU_RANK: Record<string, number> = {
  none: 0, highschool: 1, vocational: 2, associate: 3, bachelor: 4, master: 5,
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
  // hospitality / service (the pilot partner's world)
  customersupport: 'customerservice', clientservice: 'customerservice', guestservice: 'customerservice',
  guestrelations: 'customerservice',
  frontdesk: 'frontoffice', receptionist: 'frontoffice',
  fnb: 'foodandbeverage', fb: 'foodandbeverage', foodbeverage: 'foodandbeverage',
  foodsafety: 'foodsafety', servsafe: 'foodsafety',
  pointofsale: 'pos', possystem: 'pos',
  housekeeper: 'housekeeping', roomattendant: 'housekeeping',
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
  weights: { skills: number; education: number; experience: number };
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
  [k: string]: any;
}
export interface SerializedPosting {
  id: string;
  skills: string[];
  educationLevel: string;
  minExperienceMonths: number;
  [k: string]: any;
}

export interface MatchResult {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  totalSkills: number;
  eduMeets: boolean;
  expMeets: boolean;
  seekerMonths: number;
  tier: 'strong' | 'possible' | 'related';
}

/** The defaults used when the match_settings table has no overrides —
 *  the study's published 50/25/25 weights and 80/50 tier thresholds. */
export const DEFAULT_SETTINGS: MatchSettings = {
  weights: { skills: 0.5, education: 0.25, experience: 0.25 },
  thresholds: { strong: 80, related: 50 },
};

/** The pure scoring function — no database, no I/O. rmScore() wraps it
 *  with the DB-loaded settings; the test suite calls it directly. */
export function scoreWith(cfg: MatchSettings, resume: SerializedResume, posting: SerializedPosting): MatchResult {
  const W = cfg.weights;
  const T = cfg.thresholds;

  const required = posting.skills || [];
  const have = new Set((resume.skills || []).map(skillNorm));
  const matched: string[] = [];
  const missing: string[] = [];
  for (const s of required) (have.has(skillNorm(s)) ? matched : missing).push(s);
  const skillPart = required.length ? matched.length / required.length : 1.0;

  let seekerEdu = 0;
  for (const e of resume.education || []) seekerEdu = Math.max(seekerEdu, EDU_RANK[e.level] ?? 0);
  const reqEdu = EDU_RANK[posting.educationLevel] ?? 0;
  const eduPart = reqEdu === 0 ? 1.0 : Math.min(1.0, seekerEdu / reqEdu);

  let months = 0;
  for (const e of resume.experience || []) months += Number(e.months) || 0;
  const reqMonths = Number(posting.minExperienceMonths) || 0;
  const expPart = reqMonths <= 0 ? 1.0 : Math.min(1.0, months / reqMonths);

  const raw = (skillPart * W.skills + eduPart * W.education + expPart * W.experience) * 100;
  const total = Math.floor(raw + 0.5); // half-up, explicitly — must match assets/api.js score()

  return {
    score: total,
    matchedSkills: matched,
    missingSkills: missing,
    totalSkills: required.length,
    eduMeets: eduPart >= 1.0,
    expMeets: expPart >= 1.0,
    seekerMonths: months,
    tier: total >= T.strong ? 'strong' : total >= T.related ? 'possible' : 'related',
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
  extract: { skills?: string[]; education?: any[]; experience?: any[] } | null | undefined,
  posting: SerializedPosting,
): Promise<MatchResult | null> {
  if (!extract) return null;
  return scoreWith(await getSettings(), {
    skills: Array.isArray(extract.skills) ? extract.skills : [],
    education: Array.isArray(extract.education) ? extract.education : [],
    experience: Array.isArray(extract.experience) ? extract.experience : [],
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
