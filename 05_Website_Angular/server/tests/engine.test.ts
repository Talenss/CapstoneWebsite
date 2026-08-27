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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scoreWith, DEFAULT_SETTINGS, skillNorm, SKILL_ALIASES, EDU_RANK, MatchSettings, UNEVIDENCED_CREDIT, EVIDENCE_KINDS, EvidenceKind, evidenceLabels } from '../src/lib/engine';
import { scoreLocal, WEIGHTS, THRESHOLDS, normSkill, SKILL_ALIASES as CLIENT_SKILL_ALIASES, EDU_RANK as CLIENT_EDU_RANK, UNEVIDENCED_CREDIT as CLIENT_UNEVIDENCED_CREDIT, evidenceLabels as clientEvidenceLabels, SKILL_CATEGORY, missingHint } from '../../client/src/app/core/engine';

// ---------- helpers ----------

const resume = (skills: string[], eduLevels: string[] = ['bachelor'], monthsList: number[] = [12]) => ({
  id: 'r-test',
  skills,
  education: eduLevels.map((level) => ({ level })),
  experience: monthsList.map((months) => ({ months })),
});

const posting = (
  skills: string[], educationLevel = 'bachelor', minExperienceMonths = 0,
  weights?: { skills: number; education: number; experience: number } | null,
) => ({
  id: 'p-test',
  skills,
  educationLevel,
  minExperienceMonths,
  ...(weights !== undefined ? { weights } : {}),
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
  assert.deepEqual(client.unevidencedMatches, server.unevidencedMatches);
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
  assert.equal(skillNorm('CRM'), skillNorm('CRM Software'));
  assert.equal(skillNorm('Data Encoding'), skillNorm('Data Entry'));
  assert.equal(skillNorm('Detail Oriented'), skillNorm('Attention to Detail'));

  // …and it changes the actual score, on both engines (score() asserts parity).
  const abbreviated = score(resume(['JS', 'MS Office']), posting(['JavaScript', 'Microsoft Office']));
  assert.equal(abbreviated.score, 100);
  assert.deepEqual(abbreviated.missingSkills, []);
});

test('skill aliases are conservative — different skills stay different', () => {
  // Folding synonyms must never credit a skill the applicant didn't claim.
  assert.notEqual(skillNorm('JavaScript'), skillNorm('Java'));
  assert.notEqual(skillNorm('Excel'), skillNorm('Word'));
  assert.notEqual(skillNorm('Salesforce'), skillNorm('CRM Software'));  // a product is not the category
  assert.notEqual(skillNorm('Bookkeeping'), skillNorm('Accounting'));
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linaw-sniff-'));
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

/* ---------- per-opening weights ----------

   A recruiter can set what each of the three checks is worth for their own
   opening. These run through the same score() harness as everything else, so
   every case below is also asserting that the browser and the server agree —
   which is what stops a seeker seeing one number on the opening and the
   recruiter seeing another for the same application. */

test('an opening with its own weights is scored with them, not the site defaults', () => {
  // Half the skills, meets education, meets experience.
  const r = resume(['JavaScript', 'Git'], ['bachelor'], [24]);

  const dflt = score(r, posting(['JavaScript', 'Git', 'SQL', 'Excel'], 'bachelor', 12));
  // 0.5 skills × 50 + 1 × 25 + 1 × 25 = 75
  assert.equal(dflt.score, 75);

  // The same applicant against a skills-heavy version of the same opening.
  const heavy = score(r, posting(['JavaScript', 'Git', 'SQL', 'Excel'], 'bachelor', 12,
    { skills: 80, education: 10, experience: 10 }));
  // 0.5 × 80 + 1 × 10 + 1 × 10 = 60
  assert.equal(heavy.score, 60, 'weighting skills harder must cost an applicant who only has half of them');

  // And a version that leans away from skills.
  const light = score(r, posting(['JavaScript', 'Git', 'SQL', 'Excel'], 'bachelor', 12,
    { skills: 20, education: 40, experience: 40 }));
  // 0.5 × 20 + 1 × 40 + 1 × 40 = 90
  assert.equal(light.score, 90);
});

test('the weights a score was computed with travel with the score', () => {
  // The site tells the applicant they see exactly what the recruiter sees, so
  // a breakdown has to be able to state the split its own number came from.
  const r = resume(['JavaScript']);
  const custom = score(r, posting(['JavaScript'], 'bachelor', 0, { skills: 60, education: 20, experience: 20 }));
  assert.deepEqual(custom.weights, { skills: 0.6, education: 0.2, experience: 0.2 });

  const inherited = score(r, posting(['JavaScript']));
  assert.deepEqual(inherited.weights, DEFAULT_SETTINGS.weights);
});

test('an opening that sets no weights inherits whatever the site defaults are', () => {
  /* Not the same as hardcoding 50/25/25: the study retunes its published
     weights by editing match_settings, and every opening that never
     customised has to follow. */
  const tuned: MatchSettings = {
    weights: { skills: 0.7, education: 0.2, experience: 0.1 },
    thresholds: DEFAULT_SETTINGS.thresholds,
  };
  const r = resume(['JavaScript', 'Git'], ['bachelor'], [24]);
  const p = posting(['JavaScript', 'Git', 'SQL', 'Excel'], 'bachelor', 12, null);
  // 0.5 × 70 + 1 × 20 + 1 × 10 = 65
  assert.equal(scoreWith(tuned, r, p).score, 65);
});

test('a malformed weight set falls back to the defaults instead of rescaling the score', () => {
  /* Normalising 40/40/40 so it sums to 1 would score the applicant on a scale
     the recruiter never chose, and nothing downstream would look wrong. The
     published default is at least a number the site can explain. */
  const r = resume(['JavaScript', 'Git'], ['bachelor'], [24]);
  const skills = ['JavaScript', 'Git', 'SQL', 'Excel'];

  for (const bad of [
    { skills: 40, education: 40, experience: 40 },     // sums to 120
    { skills: 50, education: 25, experience: 20 },     // sums to 95
    { skills: NaN, education: 25, experience: 25 },
    { skills: -10, education: 60, experience: 50 },
  ]) {
    const got = score(r, posting(skills, 'bachelor', 12, bad as any));
    assert.equal(got.score, 75, `a weight set of ${JSON.stringify(bad)} must score as the default 50/25/25`);
    assert.deepEqual(got.weights, DEFAULT_SETTINGS.weights);
  }
});

test('the floor keeps every criterion able to move a score', () => {
  /* 10% is the lowest a recruiter may set any one part (enforced in
     routes/postings.ts, the demo adapter, and a CHECK on the table). At the
     floor the criterion still counts, which is the point of having one: an
     applicant whose only strength is education is not invisible. */
  const noEdu = resume(['JavaScript', 'Git', 'SQL', 'Excel'], ['none'], [24]);
  const hasEdu = resume(['JavaScript', 'Git', 'SQL', 'Excel'], ['master'], [24]);
  const p = posting(['JavaScript', 'Git', 'SQL', 'Excel'], 'bachelor', 12,
    { skills: 80, education: 10, experience: 10 });

  const a = score(noEdu, p);
  const b = score(hasEdu, p);
  assert.ok(b.score > a.score, 'education at the floor must still separate two applicants');
  assert.equal(b.score - a.score, 10, 'and it separates them by exactly its weight');
});

test('every seeded skill stores the norm the engine would compute for it', () => {
  /* The schema comment on skillNorm says its output is what belongs in
     `skills.skill_norm`. Two seeded rows once broke that quietly: the
     catalogue stored 'msoffice' and 'networking' while the engine turned the
     same display names into 'microsoftoffice' and 'computernetworking'.

     Scoring never noticed, because both sides of a comparison go through
     skillNorm and so both landed on the alias target. What broke was the
     lookup in ensureSkill, which searches `WHERE skill_norm = skillNorm(name)`
     — it missed the seeded row and inserted a SECOND row for the same skill
     the first time a recruiter typed "MS Office" into a posting. Verified
     against PostgreSQL at the time: the catalogue grew rows 26 and 27
     alongside the seeded 6 and 14.

     Nothing visible failed. The recruiter's skill picker de-duplicates by
     display name, so the catalogue silently accumulated duplicates while
     every screen looked correct — which is exactly why this is a test and
     not a comment. It reads the shipped seed file, so a hand-written
     skill_norm that disagrees with the engine fails here rather than in
     somebody's database months later. */
  const sql = readFileSync(join(__dirname, '..', '..', 'db', 'linaw_ph.sql'), 'utf8');
  const block = /INSERT INTO skills \(skill_name, skill_norm, category\) VALUES([\s\S]*?);/.exec(sql);
  assert.ok(block, 'the seed file must contain the skills catalogue');

  const rows = [...block![1].matchAll(/\('([^']+)','([a-z0-9]+)','[a-z]+'\)/g)]
    .map((m) => ({ name: m[1], stored: m[2] }));
  assert.ok(rows.length >= 20, `expected a populated catalogue, found ${rows.length} rows`);

  for (const { name, stored } of rows) {
    assert.equal(stored, skillNorm(name),
      `seeded skill_norm for "${name}" is '${stored}' but skillNorm() returns `
      + `'${skillNorm(name)}' — the lookup in ensureSkill would miss this row and `
      + `insert a duplicate. Fix the seed, not the engine.`);
  }

  const norms = rows.map((r) => r.stored);
  assert.equal(new Set(norms).size, norms.length, 'no two catalogue rows may share a skill_norm');
});

test('every skill a seeded posting or resume requires exists in the catalogue', () => {
  /* The seed links postings and resumes to skills by `WHERE skill_norm IN
     (...)`. A norm listed there that no catalogue row carries does not error:
     the SELECT simply matches nothing, and the posting silently comes up
     short a required skill. Renaming a catalogue norm without updating these
     lists is the obvious way to cause it, so the two are checked together. */
  const sql = readFileSync(join(__dirname, '..', '..', 'db', 'linaw_ph.sql'), 'utf8');
  const block = /INSERT INTO skills \(skill_name, skill_norm, category\) VALUES([\s\S]*?);/.exec(sql);
  const catalogue = new Set([...block![1].matchAll(/\('[^']+','([a-z0-9]+)','[a-z]+'\)/g)].map((m) => m[1]));

  let checked = 0;
  for (const m of sql.matchAll(/INSERT INTO (posting_skills|resume_skills)[\s\S]*?skill_norm IN \(([^)]*)\)/g)) {
    for (const q of m[2].matchAll(/'([a-z0-9]+)'/g)) {
      checked++;
      assert.ok(catalogue.has(q[1]),
        `${m[1]} references skill_norm '${q[1]}', which no row in the skills catalogue carries`);
    }
  }
  assert.ok(checked >= 20, `expected the seed to link many skills, found ${checked}`);
});

/* ============================================================
   EVIDENCE-LINKED SKILLS

   A matched skill the applicant can point to counts in full; one they
   cannot still counts, at UNEVIDENCED_CREDIT. These tests pin the
   constant, both branches of the arithmetic, and the one distinction the
   whole design rests on: an ABSENT evidence map means the question was
   never asked (full credit) while an EMPTY one means it was asked and
   went unanswered (partial credit).
   ============================================================ */

/** A resume plus the evidence map, keyed by the skill as written. */
const resumeEv = (
  skills: string[],
  evidence: Record<string, { kind: EvidenceKind; ref: string }> | undefined,
  eduLevels: string[] = ['bachelor'], monthsList: number[] = [12],
) => ({ ...resume(skills, eduLevels, monthsList), ...(evidence === undefined ? {} : { skillEvidence: evidence }) });

const usedAt = (ref: string) => ({ kind: 'experience' as EvidenceKind, ref });

test('the unevidenced credit is the published half, and the client mirrors it', () => {
  assert.equal(UNEVIDENCED_CREDIT, 0.5);
  assert.equal(CLIENT_UNEVIDENCED_CREDIT, UNEVIDENCED_CREDIT);
});

test('a skill with a source counts in full', () => {
  const s = score(
    resumeEv(['MySQL', 'JavaScript', 'Teamwork', 'Git'], {
      MySQL: usedAt('Developer, Acme'), JavaScript: usedAt('Developer, Acme'),
      Teamwork: usedAt('Developer, Acme'), Git: usedAt('Developer, Acme'),
    }),
    posting(['MySQL', 'JavaScript', 'Teamwork', 'Git']),
  );
  assert.equal(s.score, 100);
  assert.deepEqual(s.unevidencedMatches, []);
});

test('a skill with NO source still counts — at half, never at zero', () => {
  // 4 of 4 matched, none sourced: 4 − 4×0.5 = 2 credited → skills 50% × 0.5
  const s = score(resumeEv(['MySQL', 'JavaScript', 'Teamwork', 'Git'], {}),
                  posting(['MySQL', 'JavaScript', 'Teamwork', 'Git']));
  assert.equal(s.score, 75);
  assert.ok(s.score > 50, 'half credit must still clear the related tier — an unsourced skill is not a lie');
  assert.deepEqual(s.unevidencedMatches, ['MySQL', 'JavaScript', 'Teamwork', 'Git']);
});

test('sourced and unsourced skills mix in one score', () => {
  // 4 matched, 2 sourced: 4 − 2×0.5 = 3 credited → 0.75 × 50 + 25 + 25 = 87.5 → 88
  const s = score(
    resumeEv(['MySQL', 'JavaScript', 'Teamwork', 'Git'], {
      MySQL: usedAt('Developer, Acme'), JavaScript: usedAt('Developer, Acme'),
    }),
    posting(['MySQL', 'JavaScript', 'Teamwork', 'Git']),
  );
  assert.equal(s.score, 88);
  assert.deepEqual(s.unevidencedMatches, ['Teamwork', 'Git']);
});

test('an ABSENT evidence map means the question was never asked, so nothing is docked', () => {
  /* This is the uploaded-document path (rmFileScore): a machine read the
     file, there was no builder to ask in, and penalising the applicant for
     a screen they were never shown would be indefensible. Absent must NOT
     behave like empty. */
  const asked = score(resumeEv(['MySQL', 'JavaScript'], {}), posting(['MySQL', 'JavaScript']));
  const neverAsked = score(resumeEv(['MySQL', 'JavaScript'], undefined), posting(['MySQL', 'JavaScript']));
  assert.equal(neverAsked.score, 100);
  assert.equal(asked.score, 75);
  assert.deepEqual(neverAsked.unevidencedMatches, [],
    'a resume that was never asked must not report skills as unsourced');
});

test('evidence is matched through the same alias folding as the skill itself', () => {
  // The applicant wrote "JavaScript" and sourced it; the posting asks for "JS".
  // Failing to fold both sides would quietly halve a skill that IS sourced.
  const s = score(
    resumeEv(['JavaScript'], { JavaScript: usedAt('Developer, Acme') }),
    posting(['JS']),
  );
  assert.deepEqual(s.unevidencedMatches, []);
  assert.equal(s.score, 100);
});

test('unevidencedMatches never reports a skill the applicant does not claim', () => {
  const s = score(resumeEv(['MySQL'], {}), posting(['MySQL', 'Kubernetes']));
  assert.deepEqual(s.missingSkills, ['Kubernetes']);
  assert.deepEqual(s.unevidencedMatches, ['MySQL'],
    'only MATCHED skills can be unsourced — a skill they never claimed is missing, not unsourced');
});

test('a source on a skill the posting never asked for changes nothing', () => {
  const bare = score(resumeEv(['MySQL', 'Baking'], { MySQL: usedAt('Developer, Acme') }), posting(['MySQL']));
  const both = score(resumeEv(['MySQL', 'Baking'],
    { MySQL: usedAt('Developer, Acme'), Baking: usedAt('Baker, Bakery') }), posting(['MySQL']));
  assert.equal(bare.score, both.score);
});

test('padding the skills list is cheaper than it was, and still not free', () => {
  /* The exploit this feature answers, priced honestly. An applicant with one
     real skill who types in the other three used to reach a perfect score.
     They now reach 81 — lower, but NOT excluded. The paper must say both
     halves of that: partial credit reduces the payoff, the score snapshot in
     routes/applications.ts is what stops it moving an application already
     sent, and the recruiter's evidence panel is what makes it visible. */
  const required = ['MySQL', 'JavaScript', 'Teamwork', 'Git'];
  const honest = score(
    resumeEv(['MySQL', 'JavaScript', 'Teamwork'], {
      MySQL: usedAt('Developer, Acme'), JavaScript: usedAt('Developer, Acme'), Teamwork: usedAt('Developer, Acme'),
    }), posting(required));
  const padded = score(
    resumeEv(required, { MySQL: usedAt('Developer, Acme') }), posting(required));

  assert.equal(honest.score, 88);
  assert.equal(padded.score, 81);
  assert.ok(padded.score < 100, 'padding must no longer produce a perfect score');
  assert.ok(padded.score < honest.score,
    'three sourceless skills must not outrank three sourced ones');
});

test('the source labels the builder offers are exactly the ones the server accepts', () => {
  /* The builder fills its dropdown with evidenceLabels(); the save route
     accepts a source ONLY if it appears in evidenceLabels(). If the two
     implementations ever drift, a source the applicant picked would be
     dropped on save and their score would fall for no visible reason. */
  const r = {
    experience: [{ position: 'Web Development Intern', company: 'Clark Outsourcing' }, { position: '', company: 'Solo' }],
    projects: [{ name: 'Barangay records system' }, { name: '' }],
    certifications: [{ name: 'TESDA Web Development NC III' }],
    education: [{ degree: 'BS Information Technology', school: 'Holy Angel University' }],
  };
  const server = evidenceLabels(r);
  const client = clientEvidenceLabels(r);
  for (const kind of EVIDENCE_KINDS) {
    assert.deepEqual([...client[kind]].sort(), [...server[kind]].sort(), `evidence labels differ for ${kind}`);
  }
  assert.deepEqual([...server.experience].sort(), ['Solo', 'Web Development Intern, Clark Outsourcing']);
  assert.deepEqual([...server.education], ['BS Information Technology, Holy Angel University']);
  assert.deepEqual([...server.project], ['Barangay records system'], 'a nameless entry is not offerable as a source');
});

test('both engines agree on which matches were unsourced', () => {
  const r = resumeEv(['MySQL', 'JavaScript', 'Teamwork'], { MySQL: usedAt('Developer, Acme') });
  const p = posting(['MySQL', 'JavaScript', 'Teamwork']);
  assert.deepEqual(
    scoreLocal(r as any, p as any).unevidencedMatches,
    scoreWith(DEFAULT_SETTINGS, r as any, p as any).unevidencedMatches,
  );
});

test('the schema will accept exactly the four source kinds the engine names', () => {
  const sql = readFileSync(join(__dirname, '..', '..', 'db', 'linaw_ph.sql'), 'utf8');
  const check = /evidence_kind TEXT CHECK \(evidence_kind IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(check, 'resume_skills.evidence_kind must carry a CHECK constraint');
  const allowed = [...check![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(allowed.sort(), [...EVIDENCE_KINDS].sort(),
    'a kind the engine accepts but the database rejects would fail the save with a 500');
});

test('the skill categories the applicant hint uses match the seeded catalogue', () => {
  /* The applicant is no longer told WHICH requirements they have not met —
     only how many and of what kind. That hint reads SKILL_CATEGORY in the
     client engine, which is a copy of the `category` column in the skills
     catalogue. A copy that drifted would tell an applicant they are short two
     technical skills when they are short two soft ones, which is worse than
     saying nothing: it would send them to look at the wrong part of their own
     resume. So the copy is checked against the seed rather than trusted. */
  const sql = readFileSync(join(__dirname, '..', '..', 'db', 'linaw_ph.sql'), 'utf8');
  const block = /INSERT INTO skills \(skill_name, skill_norm, category\) VALUES([\s\S]*?);/.exec(sql);
  const rows = [...block![1].matchAll(/\('[^']+','([a-z0-9]+)','([a-z]+)'\)/g)];
  assert.ok(rows.length >= 20, `expected a seeded catalogue, found ${rows.length}`);

  for (const [, norm, category] of rows) {
    assert.equal(SKILL_CATEGORY[norm], category,
      `skills.category says "${norm}" is ${category}, SKILL_CATEGORY says ${SKILL_CATEGORY[norm] ?? 'nothing'}`);
  }
  for (const norm of Object.keys(SKILL_CATEGORY)) {
    assert.ok(rows.some(([, n]) => n === norm),
      `SKILL_CATEGORY carries "${norm}", which no row in the seeded catalogue has`);
  }
});

test('the applicant is told how many requirements are unmet, never which', () => {
  /* The behaviour the recruiter still gets — missingSkills, by name — is
     unchanged and tested elsewhere. This pins the APPLICANT-facing summary:
     it must carry the count and the kind, and must not carry a skill name
     that could be pasted into a resume. */
  const hint = missingHint(['Troubleshooting', 'Windows', 'Teamwork']);
  assert.match(hint, /3 skills/);
  assert.match(hint, /2 technical/);
  assert.match(hint, /1 workplace/);
  for (const named of ['Troubleshooting', 'Windows', 'Teamwork']) {
    assert.ok(!hint.includes(named), `the hint must not name "${named}" — it reads "${hint}"`);
  }

  assert.equal(missingHint([]), '', 'nothing to say when nothing is unmet');
  assert.match(missingHint(['Teamwork']), /1 skill this role asks for is not on your resume/);
});
