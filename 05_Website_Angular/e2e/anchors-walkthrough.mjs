/* Linaw PH — in-page anchor navigation
   ------------------------------------------------------------------
   Guards a bug class that is invisible to unit tests and easy to
   reintroduce.

   index.html sets <base href="/">. A browser resolves a BARE fragment
   link — href="#basics" — against that BASE, not against the page you
   are on. So on /learning-hub every guide link navigated to /#basics,
   which is the HOME page, and the reader lost the article entirely.
   The same defect hit the "Skip to main content" link in the shared
   header, which meant it was broken on EVERY page: a keyboard user
   pressing Tab then Enter — the first thing they would do — was thrown
   off the page they were reading, with focus dropped onto <body>.

   Both now go through code rather than a bare href: the guide links use
   routerLink + fragment (with anchorScrolling enabled in app.config.ts),
   and the skip link moves focus in a click handler, because scrolling
   alone would leave the caret in the navigation the link exists to skip.

     cd client && npm start -- --port 4210     # or serve a built bundle
     node ../e2e/anchors-walkthrough.mjs
   ------------------------------------------------------------------ */
import pkg from 'playwright';
const { chromium } = pkg;
const B = process.env.APP_URL || 'http://localhost:4210';
const EXTERNAL = /fonts\.googleapis|fonts\.gstatic/;

const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
await page.route(/fonts\.(googleapis|gstatic)\.com/, r =>
  r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 160)));
page.on('console', m => {
  if (m.type() === 'error' && !EXTERNAL.test(m.text())) errors.push('CONSOLE: ' + m.text().slice(0, 160));
});

let pass = 0, fail = 0;
const t = async (n, fn) => {
  try { await fn(); console.log('  PASS  ' + n); pass++; }
  catch (e) { console.log('  FAIL  ' + n + ' — ' + String(e.message || e).split('\n')[0].slice(0, 170)); fail++; }
};

/** Did the fragment target actually come into view?
 *  The LAST section on a page can never reach the top of the viewport —
 *  there is no content below it to scroll past — so landing at the page
 *  bottom with the section on screen is the correct outcome, not a miss. */
const reached = (id) => page.evaluate((frag) => {
  const el = document.getElementById(frag);
  if (!el) return { ok: false, why: 'no element #' + frag };
  const r = el.getBoundingClientRect();
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const atBottom = Math.abs(window.scrollY - max) < 3;
  const onScreen = r.top < window.innerHeight && r.bottom > 0;
  return {
    ok: Math.abs(r.top) < 120 || (atBottom && onScreen),
    why: `top=${Math.round(r.top)} atBottom=${atBottom} onScreen=${onScreen}`,
  };
}, id);

console.log('=== IN-PAGE ANCHORS ===');

await t('every guide link stays on the learning hub and reaches its section', async () => {
  await page.goto(B + '/learning-hub', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const n = await page.locator('.toc a').count();
  if (n < 2) throw new Error('expected a table of contents with several guides, found ' + n);

  for (let i = 0; i < n; i++) {
    await page.goto(B + '/learning-hub', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const link = page.locator('.toc a').nth(i);
    const label = (await link.innerText()).trim();
    await link.click();
    await page.waitForTimeout(1000);

    const url = page.url();
    if (!/\/learning-hub/.test(url)) {
      throw new Error(`"${label}" navigated away to ${url} (the base-href fragment bug)`);
    }
    const frag = url.split('#')[1] || '';
    if (!frag) throw new Error(`"${label}" produced no fragment`);
    const r = await reached(frag);
    if (!r.ok) throw new Error(`"${label}" did not reach #${frag} — ${r.why}`);
  }
});

await t('a guide can be linked to directly and survives a reload', async () => {
  for (const frag of ['ats', 'scores', 'mistakes']) {
    await page.goto(B + '/learning-hub#' + frag, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1300);
    const r = await reached(frag);
    if (!r.ok) throw new Error(`/learning-hub#${frag} did not reach the section — ${r.why}`);
  }
});

await t('the skip link keeps the reader on the page, on every page', async () => {
  for (const route of ['/learning-hub', '/privacy', '/browse', '/']) {
    await page.goto(B + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const before = page.url();
    await page.keyboard.press('Tab');          // a keyboard user's first move
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    if (page.url() !== before) {
      throw new Error(`${route}: skip link navigated to ${page.url()} instead of staying put`);
    }
  }
});

await t('the skip link moves the keyboard caret into the content', async () => {
  // Scrolling alone is not enough: if focus stays in the header, the next
  // Tab walks back through the navigation the link exists to skip.
  for (const route of ['/learning-hub', '/browse']) {
    await page.goto(B + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const where = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? a.tagName + (a.id ? '#' + a.id : '') : '(none)';
    });
    if (where !== 'MAIN#main') throw new Error(`${route}: focus landed on ${where}, expected MAIN#main`);
  }
});

await t('no UNHANDLED bare fragment links remain in the rendered pages', async () => {
  /* The root cause, caught structurally rather than by symptom, so a new
     href="#section" added later fails here rather than in front of a reader.

     .skip-link is exempt, and deliberately so. It keeps href="#main" because
     an <a> without href is neither focusable nor announced as a link, which
     would break the very users it serves; its default is cancelled in a click
     handler that also moves focus. That it does not navigate is not taken on
     trust — the two tests above assert it on four routes. */
  for (const route of ['/learning-hub', '/privacy', '/browse', '/']) {
    await page.goto(B + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const bare = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .filter(a => !a.classList.contains('skip-link'))
        .map(a => a.getAttribute('href'))
        .filter(h => h && h.startsWith('#') && h.length > 1));
    if (bare.length) {
      throw new Error(`${route} still has bare fragment link(s): ${bare.join(', ')} — these resolve against <base href="/"> and jump to the home page`);
    }
  }
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
console.log(errors.length ? errors.length + ' errors:\n  ' + [...new Set(errors)].slice(0, 6).join('\n  ') : '0 console/page errors');
await b.close();
process.exit(fail || errors.length ? 1 : 0);
