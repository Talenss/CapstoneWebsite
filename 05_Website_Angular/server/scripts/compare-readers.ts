/* Linaw PH — scripts/compare-readers.ts
   ------------------------------------------------------------
   Runs BOTH document readers over the same folder of resumes and
   reports where they agree and where they differ.

   The study promises this comparison (research question on the
   extraction feature), so it has to be reproducible by someone
   who did not write it. Point it at a folder and it prints a
   table; nothing is stored and no resume is modified.

     npm run compare:readers -- ./samples

   The rules reader always runs. The Gemini reader runs only when
   GEMINI_API_KEY is set — without it the script reports the rules
   column alone and says so, rather than failing.

   THE FIGURES THIS PRINTS ARE NOT ACCURACY. Neither reader is
   being checked against a human-verified answer here; they are
   being checked against EACH OTHER. Agreement is not correctness,
   and a row where both readers are wrong in the same way still
   counts as agreement. Establishing accuracy needs a labelled set
   and is a separate exercise.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { parseResume } from '../src/lib/parse-resume';
import { EDU_RANK } from '../src/lib/engine';

const EXT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

interface Summary {
  status: string;
  name: string;
  skills: number;
  skillList: string[];
  education: number;
  level: string;
  months: number;
}

const NOTHING: Summary = { status: 'failed', name: '', skills: 0, skillList: [], education: 0, level: 'none', months: 0 };

function summarise(status: string, r: any): Summary {
  if (!r) return { ...NOTHING, status };
  let level = 'none';
  for (const e of r.education || []) if ((EDU_RANK[e.level] ?? 0) > (EDU_RANK[level] ?? 0)) level = e.level;
  const skillList: string[] = (r.skills || []).slice().sort();
  return {
    status,
    name: r.personal?.fullName || '',
    skills: skillList.length,
    skillList,
    education: (r.education || []).length,
    level,
    months: (r.experience || []).reduce((t: number, e: any) => t + (Number(e.months) || 0), 0),
  };
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: npm run compare:readers -- <folder of resumes>');
    process.exit(1);
  }
  if (!fs.existsSync(dir)) {
    console.error(`No such folder: ${dir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir)
    .filter((f) => EXT_MIME[path.extname(f).toLowerCase()])
    .sort();
  if (!files.length) {
    console.error(`No readable documents in ${dir} (looked for ${Object.keys(EXT_MIME).join(', ')}).`);
    process.exit(1);
  }

  /* Imported lazily so the rules half of this script runs on a machine that
     has never had a key, which is the common case for a group member
     reproducing the comparison. */
  const hasKey = !!process.env.GEMINI_API_KEY;
  let extractResume: any = null;
  if (hasKey) ({ extractResume } = await import('../src/lib/extract'));

  console.log(`\nComparing ${files.length} document(s) in ${path.resolve(dir)}`);
  console.log(hasKey
    ? 'Both readers running. Gemini calls cost tokens.\n'
    : 'GEMINI_API_KEY is not set — reporting the rules reader only.\n');

  const head = `${pad('FILE', 26)} ${pad('READER', 7)} ${pad('STATUS', 9)} ${pad('NAME', 18)} ${pad('SKILL', 6)} ${pad('EDU', 4)} ${pad('LEVEL', 11)} MONTHS`;
  console.log(head);
  console.log('-'.repeat(head.length));

  let agreeSkills = 0, agreeLevel = 0, agreeMonths = 0, bothRead = 0;
  const rulesFailed: string[] = [];

  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const mime = EXT_MIME[path.extname(f).toLowerCase()];

    const rr = await parseResume(buf, mime, f);
    const rules = summarise(rr.status, rr.resume);
    const row = (label: string, s: Summary) => console.log(
      `${pad(f, 26)} ${pad(label, 7)} ${pad(s.status, 9)} ${pad(s.name, 18)} ${pad(String(s.skills), 6)} ${pad(String(s.education), 4)} ${pad(s.level, 11)} ${s.months}`,
    );
    row('rules', rules);
    if (rules.status !== 'ok') rulesFailed.push(f);

    if (hasKey) {
      process.env.RESUME_EXTRACTOR = 'gemini';
      const gr = await extractResume(buf, mime, f);
      const gem = summarise(gr.status, gr.resume);
      row('gemini', gem);

      if (rules.status === 'ok' && gem.status === 'ok') {
        bothRead++;
        const a = new Set(rules.skillList.map((s) => s.toLowerCase()));
        const b = new Set(gem.skillList.map((s) => s.toLowerCase()));
        const shared = [...a].filter((s) => b.has(s)).length;
        const union = new Set([...a, ...b]).size;
        if (union && shared / union >= 0.8) agreeSkills++;
        if (rules.level === gem.level) agreeLevel++;
        /* Within three months: the readers round a date range differently at
           the boundary, and treating that as disagreement would report noise
           as a finding. */
        if (Math.abs(rules.months - gem.months) <= 3) agreeMonths++;
      }
      console.log('');
    }
  }

  console.log(`\n${files.length} document(s). Rules reader failed on ${rulesFailed.length}` +
    (rulesFailed.length ? `: ${rulesFailed.join(', ')}` : '.'));

  if (hasKey && bothRead) {
    const pct = (n: number) => `${((n / bothRead) * 100).toFixed(1)}%`;
    console.log(`\nOf the ${bothRead} document(s) BOTH readers read:`);
    console.log(`  skills agree (80% overlap or better)  ${agreeSkills}/${bothRead}  ${pct(agreeSkills)}`);
    console.log(`  highest education level identical      ${agreeLevel}/${bothRead}  ${pct(agreeLevel)}`);
    console.log(`  total months within 3 of each other    ${agreeMonths}/${bothRead}  ${pct(agreeMonths)}`);
    console.log('\nAgreement is not accuracy. Neither reader was checked against a');
    console.log('human-verified answer here — where both are wrong the same way,');
    console.log('this reports agreement.');
  }
  console.log('');
}

main().catch((e) => { console.error('Failed:', e?.message || e); process.exit(1); });
