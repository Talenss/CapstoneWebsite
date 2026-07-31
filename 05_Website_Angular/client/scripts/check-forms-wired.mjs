/* ResumeMatch PH — scripts/check-forms-wired.mjs
 *
 * Catches a failure Angular does not: a component whose template binds
 * (ngSubmit) but whose `imports` array leaves out FormsModule.
 *
 * Nothing complains about this. (ngSubmit) is an output of the NgForm
 * directive; with FormsModule absent NgForm never attaches, so Angular
 * quietly registers a listener for a custom DOM event literally named
 * "ngSubmit" that nothing on earth dispatches. The template compiles, the
 * button renders, the types check — and pressing it performs a NATIVE form
 * submit: a GET to the same route that reloads the page and discards
 * everything the user typed.
 *
 * That is exactly what happened to "Publish opening" and "Save profile". A
 * recruiter could not create an opening at all — half the system — and the
 * only symptom was a page that appeared to blink and empty itself. It
 * survived every type check and every build.
 *
 * A grep is enough to make it impossible to reintroduce, so a grep is what
 * this is. Runs on every build alongside the CSP guard.
 */
import fs from 'node:fs';
import path from 'node:path';

const PAGES = path.join(import.meta.dirname, '..', 'src', 'app');

/** Every .html under src/app, with its sibling .ts. */
function* components(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { yield* components(full); continue; }
    if (!entry.name.endsWith('.html')) continue;
    const ts = full.replace(/\.html$/, '.ts');
    if (fs.existsSync(ts)) yield { html: full, ts };
  }
}

const broken = [];
let checked = 0;

for (const { html, ts } of components(PAGES)) {
  const template = fs.readFileSync(html, 'utf8');
  if (!/\(ngSubmit\)/.test(template)) continue;
  checked++;
  const source = fs.readFileSync(ts, 'utf8');
  // The import has to be in the component's own imports array, not merely
  // named somewhere in the file.
  const importsArray = source.match(/imports\s*:\s*\[([^\]]*)\]/s);
  const listed = importsArray ? /\bFormsModule\b/.test(importsArray[1]) : false;
  if (!listed) broken.push(path.relative(PAGES, ts));
}

if (broken.length) {
  console.error('\nForms guard: (ngSubmit) bound without FormsModule in the component imports.');
  console.error('These forms will perform a native page-reloading GET instead of calling the handler:\n');
  for (const f of broken) console.error('  · ' + f);
  console.error('\nAdd FormsModule to each component\'s imports array.\n');
  process.exit(1);
}

if (!checked) {
  // A guard that silently checks nothing is worse than no guard: it reports
  // success forever while the thing it protects rots.
  console.error('\nForms guard: found no (ngSubmit) templates at all — the search path is wrong.\n');
  process.exit(1);
}

console.log(`Forms guard: ${checked} form template${checked === 1 ? '' : 's'} bind (ngSubmit), all with FormsModule imported.`);
