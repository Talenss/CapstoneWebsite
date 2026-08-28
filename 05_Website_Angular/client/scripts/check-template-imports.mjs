/* Linaw PH — scripts/check-template-imports.mjs
 *
 * Catches a whole class of failure Angular does not report: a template
 * uses a directive the component forgot to import, and NOTHING complains.
 * Not the template compiler, not tsc, not the bundler. The build is clean,
 * the page renders, and the feature is simply absent.
 *
 * It only happens for usages that are legal HTML on their own:
 *
 *   (ngSubmit)="…"      an event binding. Any name is a valid listener for
 *                       a custom event, so with FormsModule missing Angular
 *                       waits for an "ngSubmit" event nothing dispatches and
 *                       the browser performs a NATIVE submit — a GET that
 *                       reloads the route and discards the form. This is
 *                       what made "Publish opening" impossible to use.
 *
 *   routerLink="/x"     a plain attribute. Without RouterLink the anchor is
 *                       rendered with href={null}: a link that looks right,
 *                       reads right, and goes nowhere when clicked.
 *
 *   appFocusTrap        likewise inert — the modal keeps its looks and
 *                       silently loses focus trapping, Escape and the
 *                       dialog role, which only a keyboard user would find.
 *
 * Property bindings are NOT in this class: [routerLink] or [ngClass] on an
 * element that has no such directive is an unknown-property error at build
 * time, so the compiler already covers them. Only the silent forms are
 * listed below.
 *
 * Verified by planting each one: removing RouterLink from browse.ts builds
 * with zero errors and renders href={null}; this script fails.
 */
import fs from 'node:fs';
import path from 'node:path';

const APP = path.join(import.meta.dirname, '..', 'src', 'app');

/** how it looks in a template  →  what imports[] must contain */
const RULES = [
  // (?<![[\w-]) keeps [routerLink] and words merely ending in these out.
  { use: 'routerLink="…"',      inTemplate: /(?<![[\w-])routerLink\s*=\s*"/,                 needs: 'RouterLink' },
  { use: 'routerLinkActive',    inTemplate: /(?<![[\w-])routerLinkActive\s*=\s*"/,           needs: 'RouterLinkActive' },
  { use: 'fragment / queryParams', inTemplate: /(?<![[\w-])(fragment|queryParams)\s*=\s*"|\[(fragment|queryParams)\]/, needs: 'RouterLink' },
  { use: 'appFocusTrap',        inTemplate: /\bappFocusTrap\b/,                              needs: 'FocusTrapDirective' },
  { use: '(ngSubmit)',          inTemplate: /\(ngSubmit\)/,                                  needs: 'FormsModule' },
  { use: '(ngModelChange)',     inTemplate: /\(ngModelChange\)/,                             needs: 'FormsModule' },
  { use: 'ngModel',             inTemplate: /\[\(ngModel\)\]|(?<![[\w-])ngModel\b/,          needs: 'FormsModule' },
];

function* templates(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { yield* templates(full); continue; }
    if (!e.name.endsWith('.html')) continue;
    const ts = full.replace(/\.html$/, '.ts');
    if (fs.existsSync(ts)) yield { html: full, ts };
  }
}

const problems = [];
const tally = new Map();
let templateCount = 0;

for (const { html, ts } of templates(APP)) {
  templateCount++;
  const tpl = fs.readFileSync(html, 'utf8');
  const src = fs.readFileSync(ts, 'utf8');
  // The name has to be in the component's own imports array — merely being
  // imported at the top of the file does nothing for the template.
  const imports = (src.match(/imports\s*:\s*\[([^\]]*)\]/s) ?? [null, ''])[1];
  const rel = path.relative(APP, ts);

  for (const rule of RULES) {
    if (!rule.inTemplate.test(tpl)) continue;
    tally.set(rule.use, (tally.get(rule.use) ?? 0) + 1);
    if (!new RegExp('\\b' + rule.needs + '\\b').test(imports)) {
      problems.push(`${rel}\n      uses ${rule.use} but imports[] has no ${rule.needs} — imports: [${imports.trim()}]`);
    }
  }
}

// A guard that checks nothing passes forever while what it protects rots.
// Both counts must be non-trivial or the search path has drifted.
const used = [...tally.values()].reduce((a, b) => a + b, 0);
if (templateCount < 10 || used < 5) {
  console.error(`\nTemplate-imports guard: only ${templateCount} templates and ${used} directive usages found — the search path is wrong.\n`);
  process.exit(1);
}

if (problems.length) {
  console.error('\nTemplate-imports guard: directives used in a template but missing from the component.');
  console.error('These compile cleanly and then do nothing at all:\n');
  for (const p of problems) console.error('  · ' + p + '\n');
  process.exit(1);
}

const summary = RULES.filter((r) => tally.get(r.use)).map((r) => `${r.use} ×${tally.get(r.use)}`).join(', ');
console.log(`Template-imports guard: ${templateCount} templates checked; ${summary} — all imported.`);
