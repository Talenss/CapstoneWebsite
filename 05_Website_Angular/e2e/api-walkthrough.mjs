/* ResumeMatch PH — API-mode walkthrough
   ------------------------------------------------------------------
   Drives the PRODUCTION bundle against the REAL Express server and a
   REAL PostgreSQL database.

   This is the mode that actually ships, and until this script existed
   nothing exercised it in a browser. The other walkthroughs run in demo
   mode, which never issues an HTTP request: no sessions, no ownership
   checks, no SQL, and — critically — no production build. The first run
   of this script found that the production bundle rendered with critical
   CSS only, because the build emitted an inline onload handler that the
   server's own Content-Security-Policy blocked. Demo mode could not have
   caught it at any level of effort.

     cd 05_Website_Angular/client && npm run build
     cd ../server && npm run build && node dist/server.js
     # then, in another terminal:
     node ../e2e/api-walkthrough.mjs

   Needs Playwright. Set PW_CHROMIUM if your Chromium lives elsewhere.
   Assumes the seeded demo accounts from db/resumematch_ph.sql.
   ------------------------------------------------------------------ */
import pkg from 'playwright';
const { chromium } = pkg;
const B = process.env.APP_URL || 'http://localhost:4300';
const EXTERNAL = /fonts\.googleapis|fonts\.gstatic/;

const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
// This container cannot reach fonts.googleapis.com. Fulfil the request so a
// known environment limit stops masquerading as an application error.
await page.route(/fonts\.(googleapis|gstatic)\.com/, r =>
  r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

const errors = [];
const apiCalls = [];
/* The guard tests below deliberately call endpoints the current role must
   not reach, so a 401/403 is the assertion passing, not an app error. The
   browser still logs "Failed to load resource" for them; counting those
   would mean a correctly-secured server reported as broken. */
const EXPECTED_REFUSAL = /Failed to load resource.*\b(401|403)\b/;
page.on('console', m => {
  if (m.type() !== 'error') return;
  const txt = m.text();
  if (EXTERNAL.test(txt) || EXPECTED_REFUSAL.test(txt)) return;
  errors.push('CONSOLE: ' + txt.slice(0, 180));
});
page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 180)));
page.on('requestfailed', r => {
  const why = r.failure()?.errorText || '';
  if (EXTERNAL.test(r.url()) || /ERR_ABORTED/.test(why)) return;
  errors.push('REQFAIL: ' + r.url().slice(0, 90) + ' — ' + why);
});
page.on('response', r => {
  if (!r.url().includes('/api/')) return;
  apiCalls.push(r.status() + ' ' + r.url().replace(B, ''));
  if (r.status() >= 500) errors.push('HTTP ' + r.status() + ' ' + r.url().replace(B, ''));
});

let pass = 0, fail = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };
const no = (n, d) => { console.log('  FAIL  ' + n + (d ? ' — ' + d : '')); fail++; };
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { no(name, String(e.message || e).split('\n')[0].slice(0, 160)); } }

/* Always clear the session first. A signed-in visitor who opens /auth is
   redirected to their dashboard by the guard — correct behaviour, but it
   means the form is not there, so switching roles mid-run must log out
   rather than assume a login form is on screen. */
const login = async (email, pw) => {
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (base) => {
    try { await fetch(base + '/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch { /* fine */ }
  }, B);
  await page.goto(B + '/auth', { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type=email]', { timeout: 15000 });
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForTimeout(1800);
};

console.log('=== API-MODE WALKTHROUGH (production bundle + real server + real PostgreSQL) ===');

await t('the bundle actually talks to the API, not localStorage', async () => {
  await page.goto(B + '/browse', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  if (!apiCalls.length) throw new Error('ZERO /api calls — this bundle is in demo mode');
  const demoDb = await page.evaluate(() => !!localStorage.getItem('rmph_v3_db'));
  if (demoDb) throw new Error('demo localStorage db present — bundle is in demo mode');
});

/* The regression that motivated this file. Under the server's CSP an inline
   handler never runs, so a stylesheet deferred with media="print" stays
   print-only and the site renders on critical CSS alone. Counting applied
   rules catches that; a screenshot diff or a "does the page load" check
   does not. */
await t('the full stylesheet actually applies (not critical CSS only)', async () => {
  await page.goto(B + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    let rules = 0;
    for (const s of document.styleSheets) {
      const m = s.media && s.media.mediaText;
      if (m && m !== 'all' && m !== '') continue;
      try { rules += s.cssRules ? s.cssRules.length : 0; } catch { /* cross-origin */ }
    }
    const btn = document.querySelector('.btn');
    return { rules, radius: btn ? getComputedStyle(btn).borderRadius : null };
  });
  if (r.rules < 200) throw new Error('only ' + r.rules + ' CSS rules applied — the main stylesheet is not reaching the screen');
  if (r.radius === '0px') throw new Error('buttons are unstyled (border-radius 0) — design system not applied');
});

await t('a guest can browse openings served from the database', async () => {
  await page.goto(B + '/browse', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  if (await page.locator('article.card.job').count() < 1) throw new Error('no openings rendered from the API');
});

await t('SEEKER · logs in and receives a real session cookie', async () => {
  await login('seeker@demo.ph', 'demo123');
  if (/\/auth/.test(page.url())) throw new Error('still on /auth — login failed');
  const cookies = await page.context().cookies();
  if (!cookies.some(c => /rmph\.sid/.test(c.name))) throw new Error('no rmph.sid session cookie');
});

await t('SEEKER · dashboard loads scored recommendations from the server', async () => {
  await page.goto(B + '/seeker-dashboard', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  if (!/%/.test(await page.locator('body').innerText())) throw new Error('no score rendered');
});

await t('SEEKER · browse scores each opening against the stored resume', async () => {
  await page.goto(B + '/browse', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  if (await page.locator('.score-ring').count() < 1) throw new Error('no per-opening scores for a signed-in seeker');
});

await t('SEEKER · my resumes lists what the database holds', async () => {
  await page.goto(B + '/my-resumes', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  if (/no resumes yet/i.test(await page.locator('body').innerText()))
    throw new Error('seeded resume did not load from the API');
});

await t('SEEKER · a builder save round-trips through SQL', async () => {
  await page.goto(B + '/resume-builder?id=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const title = page.locator('input').first();
  const stamp = 'apitest-' + Date.now();
  const before = (await title.inputValue()).replace(/ apitest-\d+$/, '');
  await title.fill(before + ' ' + stamp);
  await page.locator('button:has-text("Save")').first().click({ timeout: 5000 });
  await page.waitForTimeout(2500);
  await page.goto(B + '/my-resumes', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  if (!(await page.locator('body').innerText()).includes(stamp))
    throw new Error('the saved title did not come back from the server');
});

await t('RECRUITER · logs in and the dashboard loads from the database', async () => {
  await login('hr@demo.ph', 'demo123');
  await page.goto(B + '/hr-dashboard', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  if (/\/auth/.test(page.url())) throw new Error('recruiter was bounced to /auth');
});

await t('RECRUITER · ranked applicants render with scores', async () => {
  await page.goto(B + '/hr-applicants?id=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const txt = await page.locator('body').innerText();
  if (!/%/.test(txt) && !/no applicants yet/i.test(txt))
    throw new Error('neither scores nor an empty state rendered');
});

/* Guards must hold in the SERVER, not merely in the UI that hides a link.
   These call the API directly with a valid session for the wrong role. */
await t('a recruiter cannot pull an arbitrary resume by id', async () => {
  const r = await page.evaluate(async (base) => {
    const res = await fetch(base + '/api/resumes/get', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ id: 9999 }),
    });
    return (await res.text()).slice(0, 160);
  }, B);
  if (/"ok":true/.test(r)) throw new Error('server returned a resume it should not: ' + r);
});

await t('a seeker cannot reach a recruiter-only endpoint', async () => {
  await login('seeker@demo.ph', 'demo123');
  const r = await page.evaluate(async (base) => {
    const res = await fetch(base + '/api/postings/mine', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({}),
    });
    return (await res.text()).slice(0, 160);
  }, B);
  if (/"ok":true/.test(r)) throw new Error('seeker was served the recruiter endpoint: ' + r);
});

await t('logging out actually clears the server session', async () => {
  const r = await page.evaluate(async (base) => {
    await fetch(base + '/api/auth/logout', { method: 'POST', credentials: 'include' });
    const res = await fetch(base + '/api/auth/me', { method: 'POST', credentials: 'include' });
    return (await res.text()).slice(0, 160);
  }, B);
  if (/"role":"seeker"/.test(r)) throw new Error('session survived logout: ' + r);
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
console.log(apiCalls.length + ' API calls observed');
if (errors.length) {
  console.log('\n' + errors.length + ' app-level errors:');
  [...new Set(errors)].slice(0, 15).forEach(e => console.log('  ' + e));
} else {
  console.log('0 app-level console/page/request errors');
}
await b.close();
process.exit(fail || errors.length ? 1 : 0);
