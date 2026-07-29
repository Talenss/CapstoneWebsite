/* ResumeMatch PH — reference integrity
   ------------------------------------------------------------------
   One defect class, swept across the whole site: MARKUP THAT REFERS TO
   SOMETHING THAT IS NOT THERE.

   It started with a reported bug — clicking a guide in the learning hub
   landed on the home page, because a bare href="#basics" resolves against
   <base href="/"> rather than the current page. That is a fragment
   pointing at nothing. The same shape shows up in several other ways, and
   every one of them is invisible to unit tests and to anyone using a
   mouse and a screen:

     · a bare fragment link            → jumps to the home page
     · a link to a route that does not exist → silently falls to the 404
     · aria-controls / aria-labelledby / aria-describedby / label[for]
       naming an id that is not in the document → the relationship the
       markup claims does not exist for a screen reader
     · a duplicate id                  → every reference to it resolves to
                                         whichever element came first
     · an open dialog with no accessible name → announced as just "dialog"

   Sweeping this found two real defects beyond the reported one, both
   dangling references, and both invisible on screen.

   Runs over every route, for all four audiences, and — because most of
   this app's aria lives on things rendered conditionally — a second time
   with the modals and expandable panels OPEN.

     cd client && npm start -- --port 4210     # or serve a built bundle
     node ../e2e/reference-walkthrough.mjs
   ------------------------------------------------------------------ */
import pkg from 'playwright';
const { chromium } = pkg;
const B = process.env.APP_URL || 'http://localhost:4210';

/** Every route a signed-in user of that role can reach directly. */
const ROUTES = {
  public:    ['/', '/auth', '/browse', '/learning-hub', '/privacy'],
  seeker:    ['/seeker-dashboard', '/my-resumes', '/account', '/resume-builder', '/upload-resume'],
  recruiter: ['/hr-dashboard', '/hr-company', '/hr-posting'],
  admin:     ['/admin', '/admin/metrics'],
};
const ACCOUNTS = { seeker: 'marco@demo.ph', recruiter: 'hr@demo.ph', admin: 'admin@demo.ph' };

/** Declared in app.routes.ts. Anything else falls through to the 404 page. */
const KNOWN_ROUTES = [
  '/', '/auth', '/browse', '/learning-hub', '/privacy', '/seeker-dashboard',
  '/resume-builder', '/upload-resume', '/my-resumes', '/resume-print', '/admin',
  '/admin/metrics', '/account', '/hr-dashboard', '/hr-applicants', '/hr-posting', '/hr-company',
];

const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await b.newPage({ viewport: { width: 1400, height: 1000 } });
await page.route(/fonts\.(googleapis|gstatic)\.com/, r =>
  r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

const problems = [];
const note = (where, detail) => problems.push(`${where}: ${detail}`);
const linkTargets = new Set();

/** Everything this file looks for, in one sweep of the live DOM. */
async function sweep(where) {
  const r = await page.evaluate(() => {
    const out = { bare: [], dangling: [], dup: [], unnamedDialog: [], links: [] };

    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href');
      if (!h) continue;
      // .skip-link keeps href="#main" deliberately — an <a> without href is
      // neither focusable nor announced as a link. Its default is cancelled
      // in a click handler, and anchors-walkthrough.mjs asserts it does not
      // navigate, so it is exempt here rather than trusted silently.
      if (h.startsWith('#') && h.length > 1 && !a.classList.contains('skip-link')) {
        out.bare.push(`${h} ("${(a.textContent || '').trim().slice(0, 30)}")`);
      }
      if (h.startsWith('/') && !h.startsWith('//')) out.links.push(h);
    }

    for (const el of document.querySelectorAll('*')) {
      for (const attr of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        for (const id of v.split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(id)) out.dangling.push(`${el.tagName.toLowerCase()}[${attr}="${id}"]`);
        }
      }
    }
    for (const lab of document.querySelectorAll('label[for]')) {
      const id = lab.getAttribute('for');
      if (id && !document.getElementById(id)) out.dangling.push(`label[for="${id}"]`);
    }

    const counts = new Map();
    for (const el of document.querySelectorAll('[id]')) counts.set(el.id, (counts.get(el.id) || 0) + 1);
    for (const [id, n] of counts) if (n > 1) out.dup.push(`#${id} appears ${n} times`);

    for (const d of document.querySelectorAll('[role=dialog]')) {
      if (d.getClientRects().length === 0) continue;   // not on screen
      const lb = d.getAttribute('aria-labelledby');
      if (!((lb && document.getElementById(lb)) || d.getAttribute('aria-label'))) {
        out.unnamedDialog.push('an open dialog has no accessible name');
      }
    }
    return out;
  });

  for (const x of new Set(r.bare)) note(where, `bare fragment link ${x} — resolves against <base href="/"> and jumps to the home page`);
  for (const x of new Set(r.dangling)) note(where, `${x} — no element with that id`);
  for (const x of new Set(r.dup)) note(where, `duplicate id: ${x}`);
  for (const x of new Set(r.unnamedDialog)) note(where, x);
  r.links.forEach((l) => linkTargets.add(l));
}

async function signIn(email) {
  await page.evaluate(() => { try { sessionStorage.removeItem('rmph_v3_session'); } catch { /* api mode */ } });
  await page.goto(B + '/auth', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  if (!(await page.locator('input[type=email]').count())) return;
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'demo123');
  await page.click('button[type=submit]');
  await page.waitForTimeout(2000);
}

let pass = 0, fail = 0;
const t = async (n, fn) => {
  const before = problems.length;
  try {
    await fn();
    if (problems.length > before) throw new Error(problems.slice(before).join(' | '));
    console.log('  PASS  ' + n); pass++;
  } catch (e) {
    console.log('  FAIL  ' + n);
    for (const p of problems.slice(before)) console.log('          ' + p);
    if (!problems.slice(before).length) console.log('          ' + String(e.message || e).slice(0, 200));
    fail++;
  }
};

console.log('=== REFERENCE INTEGRITY ===');

await t('every page renders with no dangling reference (all four audiences)', async () => {
  await page.evaluate(() => { try { sessionStorage.removeItem('rmph_v3_session'); } catch {} }).catch(() => {});
  for (const route of ROUTES.public) { await page.goto(B + route, { waitUntil: 'networkidle' }); await page.waitForTimeout(1100); await sweep(route); }
  for (const role of ['seeker', 'recruiter', 'admin']) {
    await signIn(ACCOUNTS[role]);
    for (const route of ROUTES[role]) { await page.goto(B + route, { waitUntil: 'networkidle' }); await page.waitForTimeout(1200); await sweep(`${role} ${route}`); }
  }
});

await t('every in-app link points at a route that exists', async () => {
  for (const href of linkTargets) {
    const path = href.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
    if (!KNOWN_ROUTES.includes(path)) {
      note('(link target)', `${href} → "${path}" matches no route, so it lands on the 404 page`);
    }
  }
});

/* Most of this app's aria lives on conditionally rendered things, so the
   initial render of each page is the easy half. This is the half that found
   a permanently-present unnamed dialog whose focus trap never armed. */
await t('open dialogs are named, and their references resolve', async () => {
  await signIn(ACCOUNTS.seeker);

  await page.goto(B + '/seeker-dashboard', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const hist = page.locator('#apps button:has-text("History")').first();
  if (await hist.count()) { await hist.click(); await page.waitForTimeout(1400); await sweep('seeker-dashboard · history open'); }

  await page.goto(B + '/seeker-dashboard', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const apply = page.locator('button:has-text("View & apply")').first();
  if (await apply.count()) { await apply.click(); await page.waitForTimeout(1300); await sweep('seeker-dashboard · apply modal open'); }

  await page.goto(B + '/browse', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const view = page.locator('button:has-text("View")').first();
  if (await view.count()) { await view.click(); await page.waitForTimeout(1300); await sweep('browse · posting modal open'); }

  await signIn(ACCOUNTS.recruiter);
  await page.goto(B + '/hr-dashboard', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('a[href*="hr-applicants"]')]
      .map((a) => new URL(a.href).searchParams.get('id')).filter(Boolean));
  for (const id of ids) {
    await page.goto(B + '/hr-applicants?id=' + id, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1300);
    if (await page.locator('.app').count() === 0) continue;
    await page.locator('.app button:has-text("Open both resumes")').first().click();
    await page.waitForTimeout(1500);
    await sweep('hr-applicants · applicant modal open');
    const invite = page.locator('button:has-text("Message applicant")');
    if (await invite.count()) { await invite.click(); await page.waitForTimeout(1000); await sweep('hr-applicants · invite open'); }
    break;
  }
});

/* A dialog is only a dialog when one is open. If role="dialog" is in the
   document while the modal is closed, the directive that manages it was
   constructed too early — which is exactly how the applicant modal ended up
   unnamed, with a focus trap that had already fired at page load. */
await t('no dialog exists while its modal is closed, and opening one moves focus into it', async () => {
  await signIn(ACCOUNTS.recruiter);
  await page.goto(B + '/hr-dashboard', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('a[href*="hr-applicants"]')]
      .map((a) => new URL(a.href).searchParams.get('id')).filter(Boolean));
  for (const id of ids) {
    await page.goto(B + '/hr-applicants?id=' + id, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1300);
    if (await page.locator('.app').count() === 0) continue;

    const closed = await page.evaluate(() => !!document.querySelector('[role=dialog]'));
    if (closed) note('hr-applicants', 'role="dialog" is present while the modal is closed');

    await page.locator('.app button:has-text("Open both resumes")').first().click();
    await page.waitForTimeout(1500);
    const open = await page.evaluate(() => {
      const d = document.querySelector('[role=dialog]');
      const lb = d && d.getAttribute('aria-labelledby');
      return {
        exists: !!d,
        named: !!((lb && document.getElementById(lb)) || (d && d.getAttribute('aria-label'))),
        focusInside: !!(d && d.contains(document.activeElement)),
      };
    });
    if (!open.exists) note('hr-applicants', 'no dialog after opening the applicant modal');
    if (!open.named) note('hr-applicants', 'the open applicant dialog has no accessible name');
    if (!open.focusInside) note('hr-applicants', 'opening the applicant modal did not move focus inside it');
    break;
  }
});

console.log(`\n${pass}/${pass + fail} passed`);
console.log(problems.length ? `${problems.length} reference problems` : '0 reference problems');
await b.close();
process.exit(fail ? 1 : 0);
