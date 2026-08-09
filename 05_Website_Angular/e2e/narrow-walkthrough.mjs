/* ResumeMatch PH — narrow-screen walkthrough
   ------------------------------------------------------------------
   No page may scroll HORIZONTALLY on a phone.

   Why this file exists, specifically:

   `.btn` declares white-space:nowrap so a label never breaks mid-phrase
   on a comfortable screen. On a narrow phone that turns every button
   into a floor the layout cannot shrink under — a grid track will not
   go narrower than its widest item's min-content — so a single long
   label pushed whole pages past the viewport:

     "I'm Clark Outsourcing HR — request access"   home,     390px
     "Start my resume" + 34px card padding          home,     320px
     "Delete my account permanently"                account,  360px
     "Approve — create account"                     admin,    320px

   plus two that were not buttons at all: the score ladder on the
   learning hub (a badge and a sentence on one non-wrapping flex row),
   and a recruiter's email address on the admin panel, which has no
   break opportunity and was 317px wide on its own.

   Every one of these produced NO error, NO console warning and NO
   failing unit test. The page simply slid sideways under the thumb.
   Only measurement finds them, which is what this file does.

   It checks the public pages, then signs in as each role and checks
   that role's own pages, at three widths: 390 (iPhone 12-15, most
   Androids), 360 (the common Android floor) and 320 (iPhone SE 1st
   generation — the narrowest still worth supporting).

     cd 05_Website_Angular/client && npm run build:demo
     npx http-server dist/client/browser -p 4211 --proxy "http://127.0.0.1:4211?" -s &
     node ../e2e/narrow-walkthrough.mjs

   Needs playwright. If it is not installed next to this file, point at it:
     PW_MODULE=/path/to/playwright PW_CHROMIUM=/path/to/chromium node ../e2e/narrow-walkthrough.mjs
   ------------------------------------------------------------------ */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || 'playwright');

const B = (process.env.APP_URL || 'http://127.0.0.1:4211').replace(/\/$/, '');
const WIDTHS = [390, 360, 320];

const PUBLIC = ['/', '/browse', '/learning-hub', '/privacy', '/auth'];
const SIGNED_IN = {
  'seeker@demo.ph': ['/seeker-dashboard', '/browse', '/my-resumes', '/account', '/resume-builder', '/upload-resume'],
  'hr@demo.ph': ['/hr-dashboard', '/hr-posting', '/hr-company', '/account'],
  'admin@demo.ph': ['/admin', '/admin/metrics'],
};

const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
let bad = 0;
let checked = 0;

/** How far the document scrolls past its own viewport, plus — when it does —
 *  the elements actually responsible, so a failure names the culprit instead
 *  of only the page. An element is only reported when it is WIDER THAN ITS
 *  OWN PARENT (so it is the driver, not a child carried along by one) and is
 *  not inside something that clips it (a clipped box cannot extend the
 *  scrollable area, so it is innocent however wide it is). */
const measure = (page) => page.evaluate(() => {
  const de = document.documentElement;
  const over = de.scrollWidth - de.clientWidth;
  if (over <= 0) return { over, drivers: [] };
  const drivers = [];
  for (const el of document.querySelectorAll('*')) {
    const bb = el.getBoundingClientRect();
    if (!bb.width || bb.left < -1000) continue;          // off-screen skip links
    const par = el.parentElement && el.parentElement.getBoundingClientRect();
    if (!par) continue;
    if (bb.width <= par.width + 0.5 || bb.right <= de.clientWidth + 0.5) continue;
    let clipped = false;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).overflowX !== 'visible') { clipped = true; break; }
    }
    if (!clipped) {
      drivers.push(`<${el.tagName.toLowerCase()} class="${String(el.className || '').slice(0, 28)}"> `
        + `${Math.round(bb.width)}px in ${Math.round(par.width)}px`);
    }
  }
  return { over, drivers: drivers.slice(0, 3) };
});

const visit = async (page, route, label) => {
  await page.goto(B + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1100);
  const { over, drivers } = await measure(page);
  checked++;
  if (over > 0) {
    console.log(`  FAIL ${label} — scrolls ${over}px sideways`);
    for (const d of drivers) console.log(`         ${d}`);
    bad++;
  } else {
    console.log(`  ok   ${label}`);
  }
};

const newPage = async (width) => {
  const p = await b.newPage({ viewport: { width, height: 900 } });
  await p.route(/fonts\.(googleapis|gstatic)\.com/,
    (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  return p;
};

/** Clear BOTH stores. The demo session is written to localStorage as well as
 *  sessionStorage so it survives opening the print sheet in a new tab, and
 *  the adapter restores one from the other — clearing a single store logs
 *  nobody out and the next sign-in lands on an /auth that redirects away. */
const signIn = async (page, email) => {
  await page.goto(B + '/auth', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    try { sessionStorage.removeItem('rmph_v3_session'); } catch {}
    try { localStorage.removeItem('rmph_v3_session'); } catch {}
  });
  await page.goto(B + '/auth', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.fill('input[type=email]', email, { timeout: 10000 });
  await page.fill('input[type=password]', 'demo123');
  await page.click('button[type=submit]');
  await page.waitForTimeout(1600);
};

console.log('=== NO HORIZONTAL SCROLL ON A PHONE ===');
for (const width of WIDTHS) {
  console.log(`\n--- ${width}px ---`);
  const p = await newPage(width);
  for (const r of PUBLIC) await visit(p, r, r);
  await p.close();

  for (const [email, routes] of Object.entries(SIGNED_IN)) {
    const q = await newPage(width);
    try {
      await signIn(q, email);
    } catch (e) {
      console.log(`  FAIL could not sign in as ${email}: ${String(e.message).split('\n')[0].slice(0, 80)}`);
      bad++;
      await q.close();
      continue;
    }
    const who = email.split('@')[0];
    for (const r of routes) await visit(q, r, `${who} ${r}`);
    await q.close();
  }
}

await b.close();
console.log(`\n${checked} page loads checked across ${WIDTHS.length} widths`);
console.log(bad === 0 ? 'ALL PASS — nothing scrolls sideways' : `PROBLEMS: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
