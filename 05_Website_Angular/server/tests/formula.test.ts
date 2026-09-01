/* ============================================================
   THE FORMULA, CHECKED AGAINST THE PAPER
   ------------------------------------------------------------
   byThePaper() below is written from the manuscript's own words —
   Score = (S*Ws + E*We + X*Wx + C*Wc) * 100, rounded half-up —
   and NOT from the engine. The engine agreeing with it is
   therefore evidence that the code implements the published
   formula, which is a different claim from the two engines
   agreeing with each other.

   It caught nothing on the day it was written, which is the
   point: it is here so that a later change to the scoring cannot
   drift away from what the paper says without failing a test.

     cd server && npm run test:formula
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreWith, DEFAULT_SETTINGS, skillNorm, EDU_RANK } from '../src/lib/engine';
import { scoreLocal } from '../../client/src/app/core/engine';

const UNEVIDENCED = 0.5;

/* Written out rather than imported, because importing the engine's own
   constants would make the harness agree with the engine by construction and
   it would stop being independent. The one assertion below is the guard that
   keeps a deliberate retune from reading as 4000 scoring failures: if the site
   split changes, this literal is what has to be updated with it, and the
   message says so. */
const PAPER_WEIGHTS = { skills: 0.1, education: 0.2, experience: 0.7, certifications: 0 };

test('the split this harness checks against is the one the site actually uses', () => {
  assert.deepEqual(DEFAULT_SETTINGS.weights, PAPER_WEIGHTS,
    'the site weights were retuned — update PAPER_WEIGHTS here to match, or the ' +
    '4000-case sweep below will report every score as a formula disagreement');
});

/** Score = (S*Ws + E*We + X*Wx + C*Wc) * 100, rounded half-up. */
function byThePaper(resume: any, posting: any) {
  // the posting carries PERCENTAGES that must total 100; anything else falls
  // back to the published split
  const pw = posting.weights;
  const valid = pw && [pw.skills, pw.education, pw.experience].every((v: any) => typeof v === 'number' && v >= 0)
    && (pw.skills + pw.education + pw.experience + (pw.certifications || 0)) === 100;
  const W = valid
    ? { skills: pw.skills/100, education: pw.education/100, experience: pw.experience/100, certifications: (pw.certifications||0)/100 }
    : PAPER_WEIGHTS;

  const req: string[] = posting.skills || [];
  const have = new Set((resume.skills || []).map(skillNorm));
  const matched = req.filter((s) => have.has(skillNorm(s)));

  // a matched skill with a named source is worth 1, one without is worth a half.
  // an ABSENT map means the applicant was never asked, so nothing is docked.
  const map = resume.skillEvidence;
  const asked = map !== undefined && map !== null;
  const credited = matched.reduce((t, s) => {
    if (!asked) return t + 1;
    const named = Object.keys(map).some((k) => skillNorm(k) === skillNorm(s));
    return t + (named ? 1 : UNEVIDENCED);
  }, 0);
  const S = req.length ? credited / req.length : 1;

  const needLvl = EDU_RANK[posting.educationLevel as keyof typeof EDU_RANK] ?? 0;
  let hasLvl = 0;
  for (const e of resume.education || []) hasLvl = Math.max(hasLvl, EDU_RANK[e.level as keyof typeof EDU_RANK] ?? 0);
  const E = needLvl ? Math.min(1, hasLvl / needLvl) : 1;

  const needMo = Number(posting.minExperienceMonths || 0);
  const hasMo = (resume.experience || []).reduce((t: number, e: any) => t + (Number(e.months) || 0), 0);
  const X = needMo ? Math.min(1, hasMo / needMo) : 1;

  const needCerts: string[] = posting.certifications || [];
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const mine = (resume.certifications || []).map((c: any) => norm(String(c.name || '')));
  const C = needCerts.length
    ? needCerts.filter((c) => norm(String(c)) && mine.some((m: string) => m.includes(norm(String(c))))).length / needCerts.length
    : 1;

  const raw = (S * W.skills + E * W.education + X * W.experience + C * W.certifications) * 100;
  return Math.floor(raw + 0.5);
}

// ---- the sweep ----
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const pool = ['MySQL','JavaScript','HTML/CSS','Git','Teamwork','Communication','MS Office','Canva','Networking','Data Entry'];
const levels = ['none','highschool','vocational','associate','bachelor','master'];

test('4000 built resumes score the same by the paper, the server and the browser', () => {
  let n = 0, badPaper = 0, badParity = 0;
    const examples: string[] = [];
    for (let i = 0; i < 4000; i++) {
    const rSkills = pool.filter(() => rnd() < 0.5);
    const r: any = {
      skills: rSkills,
      education: rnd() < 0.2 ? [] : [{ level: pick(levels) }],
      experience: rnd() < 0.2 ? [] : [{ months: Math.floor(rnd() * 60) }],
      certifications: rnd() < 0.5 ? [] : [{ name: 'TESDA Web Development NC III' }],
    };
    const mode = Math.floor(rnd() * 3);
    if (mode === 1) r.skillEvidence = {};
    else if (mode === 2) {
      const ev: any = {}; for (const s of rSkills) if (rnd() < 0.6) ev[s] = { kind: 'experience', ref: 'x' };
      r.skillEvidence = ev;
    }
    const p: any = {
      skills: pool.filter(() => rnd() < 0.4),
      educationLevel: pick(levels),
      minExperienceMonths: Math.floor(rnd() * 36),
    };
    if (rnd() < 0.3) p.certifications = ['TESDA Web Development'];
    if (rnd() < 0.3) {
      const sk = 30 + Math.floor(rnd() * 40), ed = Math.floor((100 - sk) / 2);
      p.weights = { skills: sk, education: ed, experience: 100 - sk - ed, certifications: 0 };
    }
    const paper = byThePaper(r, p);
    const server = scoreWith(DEFAULT_SETTINGS, r, p).score;
    const client = scoreLocal(r, p).score;
    n++;
    if (paper !== server) { badPaper++; if (examples.length < 4) examples.push(`paper=${paper} server=${server} ${JSON.stringify({r,p}).slice(0,190)}`); }
    if (server !== client) badParity++;
  }
  assert.equal(badPaper, 0,
      `${badPaper} of ${n} scores disagree with the formula as the paper prints it:\n  ` + examples.join('\n  '));
  assert.equal(badParity, 0, `${badParity} of ${n} disagree between server and browser`);
});
