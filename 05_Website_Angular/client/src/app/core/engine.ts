/* ============================================================
   Matching engine + shared constants — ported 1:1 from
   04_Website/app/assets/api.js (score(), WEIGHTS, THRESHOLDS, …)
   Used by demo mode directly, and by the builder/browse/hr-posting
   pages for instant client-side "how would this score" previews
   in BOTH modes (the API mode still calls the server for anything
   that must be authoritative, e.g. applying).
   ============================================================ */
import { AppStatus, EduLevel, MatchResult, Posting, Resume, Tier } from './models';

export const WEIGHTS = { skills: 0.5, education: 0.25, experience: 0.25 };
export const THRESHOLDS = { strong: 80, related: 50 };

export const STATUS_LABELS: Record<AppStatus, string> = {
  submitted: 'Submitted', review: 'Under review', shortlisted: 'Shortlisted', rejected: 'Not selected', hired: 'Hired',
};
export const STATUS_ORDER: AppStatus[] = ['submitted', 'review', 'shortlisted', 'rejected', 'hired'];

export const EDU_RANK: Record<EduLevel, number> = {
  none: 0, highschool: 1, vocational: 2, associate: 3, bachelor: 4, master: 5,
};
export const EDU_LABELS: Record<EduLevel, string> = {
  none: 'No requirement', highschool: 'High school', vocational: 'Vocational / TESDA',
  associate: 'Associate degree', bachelor: 'Bachelor’s degree', master: 'Master’s degree',
};

export const MAX_UPLOAD = 2 * 1024 * 1024; // 2 MB
export const ALLOWED_MIME = [
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png',
];

export function normSkill(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
  return { submitted: 'slate', review: 'gold', shortlisted: 'green', hired: 'solid', rejected: 'wine' }[s] || 'slate';
}
