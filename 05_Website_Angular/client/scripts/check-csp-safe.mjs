/* Linaw PH — build-output CSP guard
   ------------------------------------------------------------------
   Fails the build if the shipped index.html contains an inline event
   handler (onload=, onclick=, …).

   Why this exists, specifically:

   The server sends a strict Content-Security-Policy, and helmet's default
   set includes `script-src-attr 'none'` — which forbids inline event
   handler attributes. Angular's critical-CSS optimizer used to emit the
   standard async-stylesheet trick into index.html:

       <link rel="stylesheet" href="styles.css" media="print"
             onload="this.media='all'">
       <noscript><link rel="stylesheet" href="styles.css"></noscript>

   With JavaScript ON — i.e. every real visitor — the CSP blocked that
   onload, the stylesheet stayed media="print", and the only fallback was
   inside <noscript>, which does not apply. The production site therefore
   rendered with critical CSS alone: 91 rules instead of 295, buttons as
   unstyled browser defaults. None of the dev-server checks could see it,
   because the dev build does not run the optimizer.

   The fix is `optimization.styles.inlineCritical: false` in angular.json.
   This guard is here so that turning it back on — or any future tool that
   emits an inline handler — fails loudly in CI instead of silently
   shipping an unstyled site.

     node scripts/check-csp-safe.mjs
   ------------------------------------------------------------------ */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, '..', 'dist', 'client', 'browser', 'index.html');

if (!existsSync(indexPath)) {
  console.error('CSP guard: no build output at ' + indexPath);
  console.error('Run `npm run build` first.');
  process.exit(1);
}

const html = readFileSync(indexPath, 'utf8');

/* Inline handlers are `on<name>=` on a TAG, so match only inside a tag and
   require a preceding space — otherwise "content=" matches as "on...tent=". */
const handlerRe = /<[^>]*?\son(load|click|error|change|submit|focus|blur|input|mouseover)\s*=/gi;
const hits = [...html.matchAll(handlerRe)].map((m) => m[0].slice(-40).trim());

/* A stylesheet parked at media="print" only reaches the screen if something
   flips it — which is exactly the blocked-handler pattern above. */
const printPinned = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi)]
  .filter((m) => /media=["']print["']/i.test(m[0]))
  .map((m) => m[0]);

let bad = false;

if (hits.length) {
  bad = true;
  console.error('CSP guard FAILED — ' + hits.length + ' inline event handler(s) in index.html:');
  for (const h of hits) console.error('  …' + h);
  console.error('\nThe server sets script-src-attr \'none\', so these never run.');
}

if (printPinned.length) {
  bad = true;
  console.error('CSP guard FAILED — stylesheet pinned to media="print":');
  for (const p of printPinned) console.error('  ' + p);
  console.error('\nNothing may flip it back under the CSP, so it never reaches the screen.');
}

if (bad) {
  console.error('\nFix: keep optimization.styles.inlineCritical = false in angular.json.');
  process.exit(1);
}

console.log('CSP guard: index.html is free of inline handlers and print-pinned stylesheets.');
