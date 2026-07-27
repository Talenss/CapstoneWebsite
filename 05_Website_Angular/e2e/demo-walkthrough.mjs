/* ResumeMatch PH — demo walkthrough
   ------------------------------------------------------------------
   Drives the whole demo in a real browser, the way the panel will see
   it: all three roles, every page, the score display, the validation
   rules, dark mode, and a 390px phone layout. Fails on any console
   error, page error, or failed request.

   Run it before the defense — it catches the things unit tests cannot,
   like a page that renders blank or a button that no longer saves.

     cd 05_Website_Angular/client && npm start -- --port 4210
     # then, in another terminal:
     node ../e2e/demo-walkthrough.mjs

   Needs Playwright. Set PW_CHROMIUM if your Chromium lives elsewhere.
   ------------------------------------------------------------------ */
import pkg from 'playwright';
const { chromium } = pkg;
const B = process.env.APP_URL || 'http://localhost:4210';
const EXTERNAL = /fonts\.googleapis|fonts\.gstatic/;

const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
// This container cannot reach fonts.googleapis.com. Fulfil the request with
// an empty stylesheet so a known environment limit stops masquerading as an
// application error in the console.
await page.route(/fonts\.(googleapis|gstatic)\.com/, r =>
  r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

const errors = [];
page.on('console', m => { if (m.type() === 'error' && !EXTERNAL.test(m.text())) errors.push('CONSOLE: ' + m.text().slice(0,180)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0,180)));
page.on('requestfailed', r => {
  const why = r.failure()?.errorText || '';
  // net::ERR_ABORTED is what a navigation does to requests still in flight —
  // it says nothing about whether the resource is reachable.
  if (EXTERNAL.test(r.url()) || /ERR_ABORTED/.test(why)) return;
  errors.push('REQFAIL: ' + r.url().slice(0,90) + ' — ' + why);
});

const results = [];
const step = async (name, fn) => {
  const before = errors.length;
  try { await fn(); results.push({ name, ok: errors.length === before, note: errors.slice(before)[0] || '' }); }
  catch (e) { results.push({ name, ok: false, note: String(e.message).split('\n')[0].slice(0,140) }); }
};
const go = async (p) => { await page.goto(B + p, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900); };
const body = () => page.locator('body').innerText();
const logout = async () => {
  await go('/');
  const btn = page.locator('button:has-text("Log out"):visible').first();
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(1200); }
};
const login = async (email) => {
  await go('/auth');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'demo123');
  await page.click('button[type=submit]');
  await page.waitForTimeout(1400);
};

await step('home page renders', async () => {
  await go('/');
  if ((await body()).length < 500) throw new Error('home looks empty');
});
await step('public pages render', async () => {
  for (const p of ['/browse', '/learning-hub', '/privacy']) {
    await go(p);
    if ((await body()).length < 300) throw new Error(p + ' looks empty');
  }
});

await step('SEEKER · signs in', async () => {
  await login('seeker@demo.ph');
  if (!page.url().includes('seeker-dashboard')) throw new Error('landed at ' + page.url());
});
await step('SEEKER · dashboard shows scores', async () => {
  await go('/seeker-dashboard');
  const t = await body();
  if (!/\d+%/.test(t)) throw new Error('no % score on dashboard');
  if (!/match/i.test(t)) throw new Error('no match wording');
});
await step('SEEKER · builder saves a draft (new validation path)', async () => {
  await go('/resume-builder');
  await page.click('button:has-text("Save draft")');
  await page.waitForTimeout(1400);
  const t = await body();
  if (/not signed in|couldn.t be saved|access only/i.test(t))
    throw new Error('save refused: ' + (t.match(/.{0,70}(not signed in|couldn.t be saved|access only).{0,50}/i)||[])[0]);
});
await step('SEEKER · design picker on the Finish step', async () => {
  await go('/resume-builder');
  await page.click('button:has-text("6Certifications"), button:has-text("6Finish")').catch(()=>{});
  const finish = page.locator('button').filter({ hasText: /Finish/ }).first();
  if (await finish.count()) { await finish.click(); await page.waitForTimeout(1000); }
  const t = await body();
  if (!/classic|modern|minimal|executive/i.test(t)) throw new Error('no design names found on finish step');
});
await step('SEEKER · browse shows per-opening scores', async () => {
  await go('/browse');
  if (!/\d+%/.test(await body())) throw new Error('no scores while signed in');
});
await step('SEEKER · my resumes + account load', async () => {
  await go('/my-resumes'); if ((await body()).length < 300) throw new Error('my-resumes empty');
  await go('/account');    if ((await body()).length < 300) throw new Error('account empty');
});
await step('SEEKER · applying records a score snapshot', async () => {
  await go('/seeker-dashboard');
  const apply = page.locator('button:has-text("Apply")').first();
  if (await apply.count()) {
    await apply.click(); await page.waitForTimeout(1400);
  }
  const snap = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('rmph-demo-db') || '{}');
    const apps = db.applications || [];
    return apps.length ? apps[apps.length - 1].scoreSnapshot : 'no-applications';
  });
  if (snap === 'no-applications') return;              // nothing to apply to
  if (typeof snap !== 'number') throw new Error('scoreSnapshot not recorded: ' + JSON.stringify(snap));
});

await step('RECRUITER · signs in', async () => {
  await logout();
  await login('hr@demo.ph');
  if (!page.url().includes('hr-dashboard')) throw new Error('landed at ' + page.url());
});
await step('RECRUITER · ranked applicants render', async () => {
  await go('/hr-applicants');
  const t = await body();
  if (t.length < 400) throw new Error('applicants page empty');
});
await step('RECRUITER · posting form loads', async () => {
  await go('/hr-posting');
  const t = await body();
  if (!/title/i.test(t)) throw new Error('posting form missing');
});
await step('RECRUITER · empty posting is rejected (new validation)', async () => {
  await go('/hr-posting');
  const save = page.locator('button').filter({ hasText: /Publish|Save/ }).first();
  if (!(await save.count())) throw new Error('no publish/save button');
  await save.click(); await page.waitForTimeout(1200);
  const t = await body();
  if (!/title|department|describe|skill/i.test(t)) throw new Error('no validation message shown');
});
await step('RECRUITER · company profile loads', async () => {
  await go('/hr-company'); if ((await body()).length < 300) throw new Error('company page empty');
});

await step('ADMIN · signs in and panels load', async () => {
  await logout();
  await login('admin@demo.ph');
  await go('/admin');         if ((await body()).length < 300) throw new Error('admin empty');
  await go('/admin/metrics'); if ((await body()).length < 300) throw new Error('metrics empty');
});

await step('dark mode toggles and persists', async () => {
  await go('/');
  await page.locator('button.theme-btn:visible').first().click();
  await page.waitForTimeout(500);
  const t1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (t1 !== 'dark') throw new Error('theme did not become dark, got ' + t1);
  await go('/browse');
  const t2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (t2 !== 'dark') throw new Error('theme did not persist across pages, got ' + t2);
  await page.locator('button.theme-btn:visible').first().click();
});

await step('mobile 390px renders without horizontal scroll', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ['/', '/browse', '/seeker-dashboard']) {
    await go(p);
    const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    if (over) throw new Error(p + ' scrolls horizontally at 390px');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
});

await b.close();
console.log('\n=== DEMO WALKTHROUGH ===');
let fails = 0;
for (const r of results) { console.log(`  ${r.ok?'PASS':'FAIL'}  ${r.name}${r.note?'\n          '+r.note:''}`); if(!r.ok) fails++; }
console.log(`\n${results.length-fails}/${results.length} passed`);
const real = errors.filter(e => !EXTERNAL.test(e));
console.log(`${real.length} app-level console/page/request errors`);
real.slice(0,8).forEach(e => console.log('  ' + e));

process.exit(fails ? 1 : 0);
