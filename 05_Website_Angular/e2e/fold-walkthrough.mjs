/* Linaw PH — the fold walkthrough
   ------------------------------------------------------------------
   Every page must reach the bottom of the viewport. A page shorter than
   the window that stops early leaves the BODY's background showing under
   it, which on /auth meant a navy panel ending 76px above the fold with
   the page's grey beneath it.

   It survived a long time because it is invisible on any page whose
   content fills the viewport by itself, which is most of them, and
   because the phone-width walkthrough runs at widths where /auth hides
   its coloured panel entirely.

   What has to hold is a chain: body → app-root → the ROUTED HOST → main.
   The router inserts each page as a sibling of <router-outlet>, so the
   host is <app-auth>, <app-home>, and so on. app-root fills on its own —
   it is a flex child of a body carrying min-height:100vh — so measuring
   app-root reports nothing while the page inside it stops short. The host
   is the element to measure.

     cd 05_Website_Angular/client && npm start -- --port 4210
     node ../e2e/fold-walkthrough.mjs
   ------------------------------------------------------------------ */
import pkg from 'playwright';
const { chromium } = pkg;
const B = process.env.APP_URL || 'http://localhost:4210';

/* Tall enough to expose it. At 900 the broken /auth came to 924px, so it
   scrolled 24px and read as an ordinary long page. */
const SIZES = [[1440, 1000], [1280, 1100]];
const PUBLIC = ['/', '/auth', '/browse', '/learning-hub', '/privacy'];
const SIGNED_IN = {
  'seeker@demo.ph': ['/seeker-dashboard', '/my-resumes', '/account', '/resume-builder', '/upload-resume', '/resume-print'],
  'hr@demo.ph': ['/hr-dashboard', '/hr-posting', '/hr-company'],
  'admin@demo.ph': ['/admin', '/admin/metrics'],
};

const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
let checked = 0, bad = 0;

const newPage = async (w, h) => {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  return p;
};
const signIn = async (page, email) => {
  await page.goto(B + '/auth', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'demo123');
  await page.click('button[type=submit]');
  await page.waitForTimeout(1500);
};

const visit = async (page, route, label) => {
  await page.goto(B + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1100);
  const gap = await page.evaluate(() => {
    const host = document.querySelector('app-root > *:not(router-outlet)');
    if (!host) return { gap: 0, tag: '(no host)' };
    // A long page overshoots and returns a negative, which is not a failure.
    return { gap: Math.round(window.innerHeight - host.getBoundingClientRect().height), tag: host.tagName };
  });
  checked++;
  if (gap.gap > 4) {
    console.log(`  FAIL ${label} — ${gap.tag} stops ${gap.gap}px above the fold`);
    bad++;
  } else {
    console.log(`  ok   ${label}`);
  }
};

console.log('=== EVERY PAGE REACHES THE FOLD ===');
for (const [w, h] of SIZES) {
  console.log(`\n--- ${w}x${h} ---`);
  const p = await newPage(w, h);
  for (const r of PUBLIC) await visit(p, r, r);
  await p.close();
  for (const [email, routes] of Object.entries(SIGNED_IN)) {
    const q = await newPage(w, h);
    await signIn(q, email);
    const who = email.split('@')[0];
    for (const r of routes) await visit(q, r, `${who} ${r}`);
    await q.close();
  }
}
await b.close();
console.log(`\n${checked} page loads checked across ${SIZES.length} viewports`);
console.log(bad === 0 ? 'ALL PASS — every page reaches the fold' : `PROBLEMS: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
