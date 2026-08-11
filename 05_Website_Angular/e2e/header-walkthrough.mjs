/* ResumeMatch PH — header layout
   ------------------------------------------------------------------
   The header carries six nav links, the visitor's name, and — on the
   seeker dashboard only, because that page passes showTour — an extra
   "Show me around" button. That one page is 165px heavier than every
   other, and it was 43px over budget: "My resumes" and "Learning hub"
   broke across two lines and the header rendered 104px tall instead of
   68px. Widening the window never helped, because the container is
   max-width capped, so the shortfall was identical at 920px and 1600px.

   These checks exist because the failure is purely visual — no error,
   no failing unit test, nothing in the console. Only measurement finds
   it. Each case asserts the row is neither WRAPPED nor CLIPPED, on
   every role's own nav set, with a deliberately long name, and at
   390px where the whole nav must collapse into the menu instead.

     cd client && npm start -- --port 4210     # or serve a built bundle
     node ../e2e/header-walkthrough.mjs
   ------------------------------------------------------------------ */
import pkg from 'playwright';
const { chromium } = pkg;
const B = process.env.APP_URL || 'http://localhost:4250';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage({ viewport: { width: 1366, height: 900 } });
await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

const login = async (email) => {
  /* Clear BOTH stores. The demo session used to live in sessionStorage
     alone; since it was made to survive opening the print sheet in a new
     tab it is written to localStorage too, and the adapter restores the
     sessionStorage copy from it. Clearing one therefore logs nobody out:
     the second login() landed on an /auth that redirected an already
     signed-in user away, and this file died on a 30s timeout waiting for
     an email field — taking the recruiter and admin header cases with it. */
  await page.evaluate(() => {
    try { sessionStorage.removeItem('rmph_v3_session'); } catch {}
    try { localStorage.removeItem('rmph_v3_session'); } catch {}
  }).catch(()=>{});
  await page.goto(B + '/auth', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'demo123');
  await page.click('button[type=submit]');
  await page.waitForTimeout(2200);
};

const check = async (label) => {
  const r = await page.evaluate(() => {
    const ul = document.querySelector('.nav-links');
    if (!ul || !ul.getClientRects().length) return { hidden: true };
    const links = [...ul.querySelectorAll('a')].filter(a => a.getClientRects().length);
    const wrapped = links.filter(a => {
      const before = a.getBoundingClientRect().height;
      const p = a.style.whiteSpace; a.style.whiteSpace = 'nowrap';
      const after = a.getBoundingClientRect().height; a.style.whiteSpace = p;
      return before > after + 1;
    }).map(a => a.textContent.trim());
    const c = document.querySelector('.site-header .container');
    return {
      hidden: false,
      clipped: Math.max(0, ul.scrollWidth - Math.round(ul.getBoundingClientRect().width)),
      wrapped,
      headerH: Math.round(c.getBoundingClientRect().height),
      labels: links.map(a => a.textContent.trim()),
    };
  });
  const ok = r.hidden || (r.clipped === 0 && r.wrapped.length === 0 && r.headerH <= 70);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${r.hidden ? '(nav in menu)' : 'h=' + r.headerH + ' clipped=' + r.clipped + (r.wrapped.length ? ' WRAPPED:' + r.wrapped.join(',') : '')}`);
  return ok;
};

let all = true;
console.log('=== HEADER STRESS ===');

// seeker, all pages, incl. the dashboard (tour button)
await login('marco@demo.ph');
for (const r of ['/seeker-dashboard', '/browse', '/my-resumes', '/account', '/resume-builder']) {
  await page.goto(B + r, { waitUntil: 'networkidle' }); await page.waitForTimeout(1200);
  all = (await check('seeker ' + r)) && all;
}

// LONG NAME — the case the whoami cap exists for
await page.goto(B + '/seeker-dashboard', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const db = JSON.parse(localStorage.getItem('rmph_v3_db'));
  const u = db.users.find(x => x.email === 'marco@demo.ph');
  u.name = 'Maria Cristina Dela Cruz-Santos';
  localStorage.setItem('rmph_v3_db', JSON.stringify(db));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
all = (await check('seeker dashboard, 31-char name')) && all;

// recruiter + admin have different nav sets
await login('hr@demo.ph');
for (const r of ['/hr-dashboard', '/hr-company']) {
  await page.goto(B + r, { waitUntil: 'networkidle' }); await page.waitForTimeout(1200);
  all = (await check('recruiter ' + r)) && all;
}
await login('admin@demo.ph');
await page.goto(B + '/admin', { waitUntil: 'networkidle' }); await page.waitForTimeout(1200);
all = (await check('admin /admin')) && all;

// mobile: the nav must collapse into the menu and still open
await login('marco@demo.ph');
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(B + '/seeker-dashboard', { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
const mob = await page.evaluate(() => {
  const burger = document.querySelector('.menu-btn');
  return { burgerVisible: !!burger?.getClientRects().length, navVisible: !!document.querySelector('.nav-links')?.getClientRects().length };
});
console.log(`  ${mob.burgerVisible && !mob.navVisible ? 'PASS' : 'FAIL'}  390px collapses to the hamburger              burger=${mob.burgerVisible} navOpen=${mob.navVisible}`);
all = (mob.burgerVisible && !mob.navVisible) && all;
await page.locator('.menu-btn').click();
await page.waitForTimeout(700);
const opened = await page.evaluate(() => {
  const ul = document.querySelector('.nav-links');
  const links = [...ul.querySelectorAll('a')].filter(a => a.getClientRects().length);
  return { count: links.length, overflowX: getComputedStyle(ul).overflowX,
           scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth };
});
console.log(`  ${opened.count >= 5 && !opened.scrollX ? 'PASS' : 'FAIL'}  menu opens with every link, no page overflow  links=${opened.count} overflow-x=${opened.overflowX} pageScrolls=${opened.scrollX}`);
all = (opened.count >= 5 && !opened.scrollX) && all;

console.log('\n' + (all ? 'ALL PASS' : 'SOME FAILED'));
await b.close();
process.exit(all ? 0 : 1);
