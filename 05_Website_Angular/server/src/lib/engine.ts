/* ============================================================
   MATCHING ENGINE — port of api/_lib.php rm_score(), which itself
   mirrors assets/api.js score(). Rule-based only — no ML, no AI.
   The applicant's uploaded file is never opened here.
   ============================================================ */
import { query, exec } from '../db';

export const EDU_RANK: Record<string, number> = {
  none: 0, highschool: 1, vocational: 2, associate: 3, bachelor: 4, master: 5,
};

export function skillNorm(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface MatchSettings {
  weights: { skills: number; education: number; experience: number };
  thresholds: { strong: number; related: number };
}

let cachedSettings: MatchSettings | null = null;

/** Weights and thresholds come from the DB, so "refined iteratively"
 *  means editing a row — not redeploying code. */
export async function getSettings(): Promise<MatchSettings> {
  if (cachedSettings) return cachedSettings;
  const rows = await query<{ setting_key: string; setting_value: string }>(
    'SELECT setting_key, setting_value FROM match_settings',
  );
  const map: Record<string, number> = {};
  for (const r of rows) map[r.setting_key] = Number(r.setting_value);
  cachedSettings = {
    weights: {
      skills: map.weight_skills ?? 0.5,
      education: map.weight_education ?? 0.25,
      experience: map.weight_experience ?? 0.25,
    },
    thresholds: {
      strong: map.threshold_strong ?? 80,
      related: map.threshold_related ?? 50,
    },
  };
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

/** Cache a computed score so the study can report on it later. */
export async function cacheScore(resumeId: number, postingId: number, s: MatchResult): Promise<void> {
  await query(
    `INSERT INTO match_scores (resume_id, posting_id, compatibility_score, skills_matched, skills_required, edu_meets, exp_meets)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE compatibility_score=VALUES(compatibility_score), skills_matched=VALUES(skills_matched),
       skills_required=VALUES(skills_required), edu_meets=VALUES(edu_meets), exp_meets=VALUES(exp_meets)`,
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
  const result = await exec('INSERT INTO skills (skill_name, skill_norm) VALUES (?,?)', [trimmed, norm]);
  return result.insertId;
}
