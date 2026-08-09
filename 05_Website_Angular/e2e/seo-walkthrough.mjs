/* ResumeMatch PH — search-engine walkthrough
   ------------------------------------------------------------------
   Checks what a crawler actually receives from each route, in a real
   browser, from the BUILT bundle — because none of it exists in the
   source. The app is client-rendered: index.html ships one title and
   one description, and core/seo.ts rewrites them per navigation. So
   the only way to know /browse and /learning-hub describe themselves
   differently is to load them and look.

   What it asserts, and why each one matters:
     · a description on every page, 70–160 chars, and NO TWO
       indexable pages sharing one — duplicate descriptions read as
       duplicate pages
     · a canonical on every page, pointing at this site
     · exactly one VISIBLE <h1> (two exist in the DOM on /auth; the
       inactive tab panel is display:none, which is fine)
     · complete Open Graph + Twitter card, or the link preview is blank
     · valid JSON-LD, and the site-level block on every page
     · the learning hub's FAQ block does not survive navigation away
       from it, which would describe the next page as answering
       questions it does not answer
     · guarded routes redirect to /auth and canonicalise there
     · the 404 route is noindex — a static host cannot send a real 404
       status for an SPA route, so the directive is the only signal
     · zero CSP violations. JSON-LD is injected into <head> at runtime
       under `script-src 'self'`; this is what proves that is allowed.

   Run it against a build, not the dev server — the dev server does
   not apply the production CSP or the optimizer:

     cd 05_Website_Angular/client
     SITE_URL=https://your-domain npm run build:demo
     npx http-server dist/client/browser -p 4211 --proxy "http://127.0.0.1:4211?" -s &
     node ../e2e/seo-walkthrough.mjs

   Needs playwright. If it is not installed next to this file, point at it:
     PW_MODULE=/path/to/playwright PW_CHROMIUM=/path/to/chromium node ../e2e/seo-walkthrough.mjs
   ------------------------------------------------------------------ */
/* Resolved through createRequire rather than a bare `import 'playwright'`.
   ESM resolution walks up from THIS file, so a bare import only finds a copy
   installed under e2e/ or above it — not one installed globally, and not one
   in client/node_modules. createRequire honours the CommonJS lookup, and
   PW_MODULE overrides it outright when playwright lives somewhere unusual. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || 'playwright');

const B = (process.env.APP_URL || 'http://127.0.0.1:4211').replace(/\/$/, '');

const ROUTES = [
  { path: '/', wantTitle: /Resume Builder/i, wantDesc: /Clark Freeport Zone/ },
  { path: '/browse', wantTitle: /Openings at Clark Outsourcing/i, wantDesc: /compatibility score/ },
  { path: '/learning-hub', wantTitle: /ATS-Friendly Resume/i, wantDesc: /applicant tracking software/ },
  { path: '/privacy', wantTitle: /Privacy notice/i, wantDesc: /Republic Act 10173/ },
  { path: '/auth', wantTitle: /free account/i, wantDesc: /Angeles City/ },
  /* The auth guard redirects a logged-out visitor — and every crawler is
     logged out — to /auth before the page loads. So what matters here is
     that the redirect lands cleanly and canonicalises to /auth, not the
     route's own noindex, which never gets a chance to apply. */
  { path: '/account', redirectsTo: '/auth' },
  { path: '/seeker-dashboard', redirectsTo: '/auth' },
  { path: '/hr-dashboard', redirectsTo: '/auth' },
  { path: '/definitely-not-a-page', index: false, wantTitle: /Page not found/i },
];

const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
let bad = 0;
const seenDesc = new Map();

for (const r of ROUTES) {
  const p = await b.newPage();
  const csp = [];
  p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text()); });
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (x) => x.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await p.goto(B + r.path, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);

  const got = await p.evaluate(() => ({
    title: document.title,
    desc: document.querySelector('meta[name="description"]')?.content ?? null,
    robots: document.querySelector('meta[name="robots"]')?.content ?? null,
    canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? null,
    ogUrl: document.querySelector('meta[property="og:url"]')?.content ?? null,
    ogImage: document.querySelector('meta[property="og:image"]')?.content ?? null,
    twCard: document.querySelector('meta[name="twitter:card"]')?.content ?? null,
    h1: Array.from(document.querySelectorAll('h1'))
      .filter((h) => h.offsetParent !== null)
      .map((h) => h.textContent.trim().slice(0, 44)),
    ld: Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((s) => ({ id: s.id, json: s.textContent })),
  }));

  const fail = (m) => { console.log(`  FAIL ${r.path}: ${m}`); bad++; };
  console.log(`\n${r.path}`);
  console.log(`  title    ${JSON.stringify(got.title)} (${got.title.length})`);
  console.log(`  desc     ${got.desc ? got.desc.length + ' chars' : 'MISSING'}`);
  console.log(`  robots   ${got.robots}`);
  console.log(`  canon    ${got.canonical}`);
  console.log(`  h1       ${JSON.stringify(got.h1)}`);
  console.log(`  json-ld  ${got.ld.map((l) => l.id || '(inline)').join(', ') || 'none'}`);

  if (csp.length) fail('CSP violations: ' + csp.join(' | '));

  if (r.redirectsTo) {
    const landed = new URL(p.url()).pathname;
    if (landed !== r.redirectsTo) fail(`expected a redirect to ${r.redirectsTo}, landed on ${landed}`);
    if (got.canonical !== B + r.redirectsTo) fail('canonical should follow the redirect: ' + got.canonical);
    await p.close();
    continue;
  }

  if (!got.desc) fail('no meta description');
  // Length only matters where the description can be SHOWN. A noindex page
  // never appears in a result, so holding it to the same window would be
  // padding out text nobody will read.
  else if (r.index !== false && (got.desc.length < 70 || got.desc.length > 160))
    fail(`description ${got.desc.length} chars (want 70-160)`);

  if (!got.canonical) fail('no canonical');
  else if (!got.canonical.startsWith(B)) fail('canonical points off-site: ' + got.canonical);
  if (got.h1.length !== 1) fail(`${got.h1.length} visible <h1> elements (want exactly 1)`);
  if (!got.ogTitle || !got.ogUrl || !got.ogImage) fail('incomplete Open Graph');
  if (got.twCard !== 'summary_large_image') fail('twitter card missing');
  if (got.title.length > 65) fail(`title ${got.title.length} chars — Google truncates around 60`);

  if (r.index === false && !/noindex/.test(got.robots ?? '')) fail('should be noindex, is: ' + got.robots);
  if (r.index !== false && /noindex/.test(got.robots ?? '')) fail('should be indexable, is: ' + got.robots);
  if (r.wantTitle && !r.wantTitle.test(got.title)) fail('title does not match ' + r.wantTitle);
  if (r.wantDesc && !r.wantDesc.test(got.desc ?? '')) fail('description does not match ' + r.wantDesc);

  if (r.index !== false && got.desc) {
    if (seenDesc.has(got.desc)) fail(`description identical to ${seenDesc.get(got.desc)}`);
    seenDesc.set(got.desc, r.path);
  }

  for (const l of got.ld) {
    try { JSON.parse(l.json); } catch (e) { fail(`json-ld ${l.id} is not valid JSON: ${e.message}`); }
  }
  if (!got.ld.some((l) => l.id === 'ld-site')) fail('site-level JSON-LD missing');

  /* JobPosting is gated behind environment.publishJobPostings, which is off
     until the openings are real vacancies rather than seeded demonstration
     data. Report which state this build is in, and validate the block when
     it is present rather than asserting a fixed answer. */
  if (r.path === '/browse') {
    const jobsBlock = got.ld.find((l) => l.id === 'ld-jobs');
    if (!jobsBlock) {
      console.log('  jobs     JobPosting OFF (publishJobPostings=false) — as shipped');
    } else {
      const jobs = JSON.parse(jobsBlock.json);
      console.log(`  jobs     JobPosting ON — ${jobs.length} listing(s)`);
      for (const j of jobs) {
        for (const k of ['title', 'description', 'datePosted', 'hiringOrganization', 'jobLocation'])
          if (!j[k]) fail(`JobPosting "${j.title}" is missing ${k}`);
        if (j.employmentType === 'OTHER') fail(`employment type did not map on "${j.title}"`);
        const a = j.jobLocation?.address ?? {};
        if (a.addressLocality && a.streetAddress && a.streetAddress.includes(a.addressLocality))
          fail(`address repeats the locality inside the street line on "${j.title}"`);
      }
    }
  }

  await p.close();
}

/* The FAQ block belongs to the learning hub alone. */
{
  const p = await b.newPage();
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (x) => x.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await p.goto(B + '/learning-hub', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  const onHub = !!(await p.$('#ld-faq'));
  await p.evaluate(() => document.querySelector('a[href="/privacy"]')?.click());
  await p.waitForTimeout(900);
  const afterNav = !!(await p.$('#ld-faq'));
  console.log(`\nFAQ block: on /learning-hub = ${onHub}, still present after navigating away = ${afterNav}`);
  if (!onHub) { console.log('  FAIL: no FAQ block on the learning hub'); bad++; }
  if (afterNav) { console.log('  FAIL: FAQ block leaked onto the next page'); bad++; }
  await p.close();
}

await b.close();
console.log(bad === 0 ? '\nOK — no problems' : `\nPROBLEMS: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
