/* ============================================================
   MATCHING ENGINE TEST SUITE
   ------------------------------------------------------------
   Proves the published formula does exactly what the paper says:
     score = skills×50% + education×25% + experience×25%
   with tiers Strong ≥ 80, Possible ≥ 50, Related < 50.

   Runs against BOTH implementations — the server's rmScore
   (via its pure core, scoreWith) and the client's scoreLocal —
   and finishes with a parity sweep proving the two are
   byte-for-byte the same engine.

     cd server && npm test
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreWith, DEFAULT_SETTINGS, skillNorm, SKILL_ALIASES, EDU_RANK, MatchSettings } from '../src/lib/engine';
import { scoreLocal, WEIGHTS, THRESHOLDS, normSkill, SKILL_ALIASES as CLIENT_SKILL_ALIASES, EDU_RANK as CLIENT_EDU_RANK } from '../../client/src/app/core/engine';

// ---------- helpers ----------

const resume = (skills: string[], eduLevels: string[] = ['bachelor'], monthsList: number[] = [12]) => ({
  id: 'r-test',
  skills,
  education: eduLevels.map((level) => ({ level })),
  experience: monthsList.map((months) => ({ months })),
});

const posting = (skills: string[], educationLevel = 'bachelor', minExperienceMonths = 0) => ({
  id: 'p-test',
  skills,
  educationLevel,
  minExperienceMonths,
});

/** Run one case through BOTH engines and assert they agree before
 *  returning the result — every scenario is automatically a parity test. */
function score(r: ReturnType<typeof resume>, p: ReturnType<typeof posting>) {
  const server = scoreWith(DEFAULT_SETTINGS, r, p);
  const client = scoreLocal(r as any, p as any);
  assert.equal(client.score, server.score, 'client and server scores must match');
  assert.equal(client.tier, server.tier, 'client and server tiers must match');
  assert.equal(client.eduMeets, server.eduMeets);
  assert.equal(client.expMeets, server.expMeets);
  assert.deepEqual(client.matchedSkills, server.matchedSkills);
  assert.deepEqual(client.missingSkills, server.missingSkills);
  return server;
}

// ---------- the published constants ----------

test('weights are the published 50/25/25 and sum to 1', () => {
  assert.deepEqual(DEFAULT_SETTINGS.weights, { skills: 0.5, education: 0.25, experience: 0.25 });
  assert.deepEqual(WEIGHTS, DEFAULT_SETTINGS.weights); // client mirrors server
  const w = DEFAULT_SETTINGS.weights;
  assert.equal(w.skills + w.education + w.experience, 1);
});

test('tier thresholds are the published 80 (strong) and 50 (related)', () => {
  assert.deepEqual(DEFAULT_SETTINGS.thresholds, { strong: 80, related: 50 });
  assert.deepEqual(THRESHOLDS, DEFAULT_SETTINGS.thresholds);
});

test('education ladder ranks match on both sides', () => {
  assert.deepEqual(EDU_RANK, { none: 0, highschool: 1, vocational: 2, associate: 3, bachelor: 4, master: 5 });
  assert.deepEqual(CLIENT_EDU_RANK as Record<string, number>, EDU_RANK);
});

// ---------- skills (50%) ----------

test('all required skills present → full skill credit → 100', () => {
  const s = score(resume(['MySQL', 'JavaScript', 'Teamwork']), posting(['MySQL', 'JavaScript', 'Teamwork']));
  assert.equal(s.score, 100);
  assert.equal(s.tier, 'strong');
  assert.deepEqual(s.matchedSkills, ['MySQL', 'JavaScript', 'Teamwork']);
  assert.deepEqual(s.missingSkills, []);
});

test('half the required skills → exactly the 50% weight halved → 75', () => {
  const s = score(resume(['MySQL', 'JavaScript']), posting(['MySQL', 'JavaScript', 'POS', 'Food Safety']));
  // 0.5×50 + 1.0×25 + 1.0×25 = 75
  assert.equal(s.score, 75);
  assert.equal(s.tier, 'possible');
  assert.deepEqual(s.missingSkills, ['POS', 'Food Safety']);
});

test('skill matching ignores case, spacing, and punctuation', () => {
  assert.equal(skillNorm('  My-SQL  '), 'mysql');
  assert.equal(normSkill('Node.js'), skillNorm('NodeJS')); // client norm == server norm
  const s = score(resume(['my-sql', ' JAVASCRIPT ', 'node.js']), posting(['MySQL', 'JavaScript', 'NodeJS']));
  assert.equal(s.score, 100);
});

test('skill aliases: equivalent wording scores the same (no vocabulary false negatives)', () => {
  // The unfairness this guards against: writing "JS" instead of
  // "JavaScript" used to score 0 for that requirement.
  assert.equal(skillNorm('JS'), skillNorm('JavaScript'));
  assert.equal(skillNorm('MS Office'), skillNorm('Microsoft Office'));
  assert.equal(skillNorm('Customer Support'), skillNorm('Customer Service'));
  assert.equal(skillNorm('F&B'), skillNorm('Food and Beverage'));
  assert.equal(skillNorm('Front Desk'), skillNorm('Front Office'));

  // …and it changes the actual score, on both engines (score() asserts parity).
  const abbreviated = score(resume(['JS', 'MS Office']), posting(['JavaScript', 'Microsoft Office']));
  assert.equal(abbreviated.score, 100);
  assert.deepEqual(abbreviated.missingSkills, []);
});

test('skill aliases are conservative — different skills stay different', () => {
  // Folding synonyms must never credit a skill the applicant didn't claim.
  assert.notEqual(skillNorm('JavaScript'), skillNorm('Java'));
  assert.notEqual(skillNorm('Excel'), skillNorm('Word'));
  assert.notEqual(skillNorm('Housekeeping'), skillNorm('Front Office'));
  const s = score(resume(['Java']), posting(['JavaScript']));
  assert.equal(s.score, 50); // education + experience only; skills earn nothing
  assert.deepEqual(s.missingSkills, ['JavaScript']);
});

test('the alias table is self-consistent (every target is itself canonical)', () => {
  // A value that is also a key would make normalization order-dependent.
  for (const [variant, canonical] of Object.entries(SKILL_ALIASES)) {
    assert.equal(SKILL_ALIASES[canonical] ?? canonical, canonical,
      `alias "${variant}" points at "${canonical}", which is itself an alias`);
    assert.equal(skillNorm(variant), canonical);
  }
});

test('client and server ship the SAME alias table', () => {
  assert.deepEqual(CLIENT_SKILL_ALIASES, SKILL_ALIASES);
});

test('matched/missing lists keep the POSTING’s original casing', () => {
  const s = score(resume(['mysql']), posting(['MySQL', 'POS Systems']));
  assert.deepEqual(s.matchedSkills, ['MySQL']);
  assert.deepEqual(s.missingSkills, ['POS Systems']);
});

test('duplicate skills on the resume don’t double-count', () => {
  const s = score(resume(['MySQL', 'MySQL', 'my sql']), posting(['MySQL', 'JavaScript']));
  // still only 1 of 2 required → 0.5×50 + 25 + 25 = 75
  assert.equal(s.score, 75);
});

test('a posting with no required skills gives full skill credit', () => {
  const s = score(resume([]), posting([], 'bachelor', 0));
  assert.equal(s.score, 100);
  assert.equal(s.totalSkills, 0);
});

// ---------- education (25%) ----------

test('education below requirement earns proportional credit, not zero', () => {
  const s = score(resume(['A'], ['highschool']), posting(['A'], 'bachelor', 0));
  // highschool(1)/bachelor(4) = 0.25 → 50 + 6.25 + 25 = 81.25 → 81
  assert.equal(s.score, 81);
  assert.equal(s.eduMeets, false);
});

test('education above requirement is capped at full credit', () => {
  const s = score(resume(['A'], ['master']), posting(['A'], 'bachelor', 0));
  assert.equal(s.score, 100);
  assert.equal(s.eduMeets, true);
});

test('the HIGHEST education entry counts, not the sum', () => {
  const low = score(resume(['A'], ['highschool']), posting(['A'], 'master', 0));
  const both = score(resume(['A'], ['highschool', 'master']), posting(['A'], 'master', 0));
  assert.ok(both.score > low.score);
  assert.equal(both.eduMeets, true);
});

test("'none' education requirement is always fully met", () => {
  const s = score(resume(['A'], []), posting(['A'], 'none', 0));
  assert.equal(s.score, 100);
  assert.equal(s.eduMeets, true);
});

// ---------- experience (25%) ----------

test('partial experience earns the proportional share — and shows half-up rounding', () => {
  const s = score(resume(['A'], ['bachelor'], [6]), posting(['A'], 'bachelor', 12));
  // 50 + 25 + (6/12)×25 = 87.5 → rounds half-up to 88
  assert.equal(s.score, 88);
  assert.equal(s.expMeets, false);
  assert.equal(s.seekerMonths, 6);
});

test('experience beyond the requirement is capped at full credit', () => {
  const s = score(resume(['A'], ['bachelor'], [24]), posting(['A'], 'bachelor', 12));
  assert.equal(s.score, 100);
});

test('experience entries are summed across jobs', () => {
  const s = score(resume(['A'], ['bachelor'], [3, 3]), posting(['A'], 'bachelor', 6));
  assert.equal(s.expMeets, true);
  assert.equal(s.seekerMonths, 6);
});

test('zero-month requirement is met even with no experience at all', () => {
  const s = score(resume(['A'], ['bachelor'], []), posting(['A'], 'bachelor', 0));
  assert.equal(s.score, 100);
  assert.equal(s.expMeets, true);
});

// ---------- tiers, exactly at the boundaries ----------

test('exactly 80 is Strong; 79 is Possible', () => {
  // full skills (50) + full edu (25) + 2/10 months (5) = 80
  const at80 = score(resume(['A'], ['bachelor'], [2]), posting(['A'], 'bachelor', 10));
  assert.equal(at80.score, 80);
  assert.equal(at80.tier, 'strong');
  // full skills (50) + full edu (25) + 4/25 months (4) = 79
  const at79 = score(resume(['A'], ['bachelor'], [4]), posting(['A'], 'bachelor', 25));
  assert.equal(at79.score, 79);
  assert.equal(at79.tier, 'possible');
});

test('exactly 50 is Possible; 49 is Related', () => {
  // 1/2 skills (25) + full edu (25) + 0/12 months (0) = 50
  const at50 = score(resume(['A'], ['bachelor'], []), posting(['A', 'B'], 'bachelor', 12));
  assert.equal(at50.score, 50);
  assert.equal(at50.tier, 'possible');
  // 0/1 skills (0) + full edu (25) + 24/25 months (24) = 49
  const at49 = score(resume([], ['bachelor'], [24]), posting(['X'], 'bachelor', 25));
  assert.equal(at49.score, 49);
  assert.equal(at49.tier, 'related');
});

test('an empty resume against a demanding posting scores 0 — Related, never hidden', () => {
  const s = score(resume([], [], []), posting(['A', 'B'], 'bachelor', 12));
  assert.equal(s.score, 0);
  assert.equal(s.tier, 'related');
  assert.deepEqual(s.missingSkills, ['A', 'B']);
});

// ---------- the settings really steer the engine ----------

test('scoreWith honors non-default weights (the DB-tunable settings)', () => {
  const skillsOnly: MatchSettings = { weights: { skills: 1, education: 0, experience: 0 }, thresholds: { strong: 80, related: 50 } };
  const s = scoreWith(skillsOnly, resume(['A'], [], []), posting(['A', 'B'], 'master', 120));
  assert.equal(s.score, 50); // 1/2 skills × 100% weight, nothing else counts
});

// ---------- the seeded demo personas (documented, checkable numbers) ----------

const juniorWebDev = posting(['HTML/CSS', 'JavaScript', 'MySQL', 'Teamwork'], 'bachelor', 0);

test('Juan (all 4 skills, BSIT, 4 mo) vs Junior Web Developer → 100 Strong', () => {
  const s = score(resume(['HTML/CSS', 'JavaScript', 'MySQL', 'Teamwork', 'Communication'], ['bachelor'], [4]), juniorWebDev);
  assert.equal(s.score, 100);
  assert.equal(s.tier, 'strong');
});

test('Ana (3 of 4 skills) vs Junior Web Developer → 88 Strong', () => {
  const s = score(resume(['HTML/CSS', 'JavaScript', 'Communication', 'Teamwork'], ['bachelor'], [3]), juniorWebDev);
  assert.equal(s.score, 88); // 0.75×50 + 25 + 25 = 87.5 → 88
  assert.equal(s.tier, 'strong');
});

test('Marco (1 of 4 skills, hospitality) vs Junior Web Developer → 63 Possible — visible, not rejected', () => {
  const s = score(
    resume(['Customer Service', 'Communication', 'MS Office', 'English Proficiency', 'POS', 'Teamwork', 'Food Safety'], ['bachelor'], [6]),
    juniorWebDev,
  );
  assert.equal(s.score, 63); // 0.25×50 + 25 + 25 = 62.5 → 63
  assert.equal(s.tier, 'possible');
});

// ---------- parity sweep: the two engines are the same engine ----------

test('500 randomized cases: server rmScore core and client scoreLocal agree exactly', () => {
  // deterministic LCG so failures are reproducible
  let seed = 20260718;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

  const skillPool = ['MySQL', 'JavaScript', 'HTML/CSS', 'POS', 'Food Safety', 'Teamwork', 'Guest Relations', 'Networking', 'Canva', 'Leadership'];
  const levels = ['none', 'highschool', 'vocational', 'associate', 'bachelor', 'master'];

  for (let i = 0; i < 500; i++) {
    const rSkills = skillPool.filter(() => rnd() < 0.5);
    const pSkills = skillPool.filter(() => rnd() < 0.4);
    const r = resume(rSkills, rnd() < 0.15 ? [] : [pick(levels)], rnd() < 0.15 ? [] : [Math.floor(rnd() * 60)]);
    const p = posting(pSkills, pick(levels), Math.floor(rnd() * 36));
    score(r, p); // asserts parity internally
  }
});

/* ============================================================
   FILE TYPE SNIFFING
   The multipart Content-Type is supplied by the client, so it is a
   claim rather than a fact. These prove we check the actual bytes.
   ============================================================ */
test('a file is identified by its bytes, not its declared type', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { sniffFileType, typeMatches } = require('../src/lib/file-type');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmph-sniff-'));
  const write = (name: string, bytes: number[] | string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.from(typeof bytes === 'string' ? bytes : bytes));
    return p;
  };

  try {
    // real signatures are recognised
    assert.equal(sniffFileType(write('a.pdf', '%PDF-1.7\n...')), 'pdf');
    assert.equal(sniffFileType(write('b.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
    assert.equal(sniffFileType(write('c.jpg', [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'jpg');
    assert.equal(sniffFileType(write('d.doc', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'doc');
    assert.equal(sniffFileType(write('e.docx', [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])), 'docx');

    // a text file claiming to be a PDF is not a PDF
    assert.equal(sniffFileType(write('f.pdf', 'this is not a pdf at all')), null);
    // nor is an executable
    assert.equal(sniffFileType(write('g.pdf', [0x4d, 0x5a, 0x90, 0x00])), null);
    // an empty file has nothing to identify
    assert.equal(sniffFileType(write('h.pdf', '')), null);
    // a missing file must not throw
    assert.equal(sniffFileType(path.join(dir, 'does-not-exist.pdf')), null);

    // .doc and .docx are interchangeable; nothing else is
    assert.equal(typeMatches('docx', 'doc'), true);
    assert.equal(typeMatches('doc', 'docx'), true);
    assert.equal(typeMatches('pdf', 'pdf'), true);
    assert.equal(typeMatches('png', 'pdf'), false, 'a PNG must never pass as a PDF');
    assert.equal(typeMatches('docx', 'pdf'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
