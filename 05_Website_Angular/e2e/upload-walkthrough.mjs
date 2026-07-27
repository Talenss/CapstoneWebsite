/* ResumeMatch PH — upload & disclosure walkthrough
   ------------------------------------------------------------------
   Drives the applicant's own-file upload through the real browser UI:
   the picker, the 2 MB limit, the type whitelist, and the promise the
   paper makes — that an uploaded file is stored and shown but never
   scored. Also checks the privacy page still discloses where the
   optional AI upload goes.

     cd 05_Website_Angular/client && npm start -- --port 4210
     node ../e2e/upload-walkthrough.mjs
   ------------------------------------------------------------------ */
import pkg from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { chromium } = pkg;
const B = process.env.APP_URL || 'http://localhost:4210';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmph-upload-'));
const pdf = path.join(dir, 'my-cv.pdf');
fs.writeFileSync(pdf, Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'));
const big = path.join(dir, 'huge.pdf');
fs.writeFileSync(big, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3 * 1024 * 1024, 0x20)]));
const sh = path.join(dir, 'script.sh');
fs.writeFileSync(sh, '#!/bin/sh\necho hi\n');

const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 160)));

const results = [];
const step = async (n, fn) => { try { await fn(); results.push([n, true, '']); }
  catch (e) { results.push([n, false, String(e.message).split('\n')[0].slice(0, 150)]); } };
const go = async p => { await page.goto(B + p, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900); };

await go('/auth');
await page.fill('input[type=email]', 'seeker@demo.ph');
await page.fill('input[type=password]', 'demo123');
await page.click('button[type=submit]');
await page.waitForTimeout(1400);

await step('the builder exposes a file input for the applicant’s own file', async () => {
  await go('/resume-builder');
  const finish = page.locator('button').filter({ hasText: /Finish/ }).first();
  if (await finish.count()) { await finish.click(); await page.waitForTimeout(900); }
  const input = page.locator('input[type=file]#ownFile, input[type=file]');
  if (!(await input.count())) throw new Error('no file input on the builder');
});

await step('a valid PDF attaches and is named back to the applicant', async () => {
  const input = page.locator('input[type=file]').first();
  await input.setInputFiles(pdf);
  await page.waitForTimeout(1600);
  const t = await page.locator('body').innerText();
  if (!/my-cv\.pdf/i.test(t)) throw new Error('the attached filename is not shown back: ' + t.slice(0, 160));
});

await step('the attached file is stored but is NOT part of the score', async () => {
  // The seed data already contains a resume with an attachment, so match the
  // file THIS test uploaded rather than the first one with any ownFile.
  const state = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('rmph_v3_db') || '{}');
    const r = (db.resumes || []).find(x => x.ownFile && /my-cv\.pdf/i.test(x.ownFile.name));
    return r ? { name: r.ownFile.name, hasData: !!r.ownFile.dataUrl,
                 scoredFields: { skills: r.skills?.length ?? 0 } } : null;
  });
  if (!state) throw new Error('the uploaded file was not persisted');
  if (!state.hasData) throw new Error('the file contents were not stored');
  // the UI must say so plainly — this is the paper's dual-resume claim
  const t = await page.locator('body').innerText();
  if (!/not part of the score|never.*scor|not scored/i.test(t))
    throw new Error('the UI does not state that the file is not scored');
});

const clearAttachment = async () => {
  // The picker is replaced by the attached-file card once a file is on, so
  // remove it before the next attempt.
  const rm = page.locator('button:has-text("Remove"), button:has-text("Replace")').first();
  if (await rm.count()) { await rm.click(); await page.waitForTimeout(900); }
};

await step('an oversized file is refused with a size message', async () => {
  await clearAttachment();
  const input = page.locator('input[type=file]').first();
  await input.waitFor({ state: 'attached', timeout: 8000 });
  await input.setInputFiles(big);
  await page.waitForTimeout(1600);
  const t = await page.locator('body').innerText();
  if (!/2\s*MB|larger|too large/i.test(t)) throw new Error('no size message shown: ' + t.slice(0, 200));
});

await step('a non-document file is refused', async () => {
  await clearAttachment();
  const input2 = page.locator('input[type=file]').first();
  await input2.waitFor({ state: 'attached', timeout: 8000 });
  await input2.setInputFiles(sh);
  await page.waitForTimeout(1600);
  const t = await page.locator('body').innerText();
  if (!/PDF|Word|image|JPG|PNG/i.test(t)) throw new Error('no type message shown: ' + t.slice(0, 200));
});

await step('the upload-and-analyze page loads and states where the file goes', async () => {
  await go('/upload-resume');
  const t = await page.locator('body').innerText();
  if (!/2\s*MB/.test(t)) throw new Error('the size limit is not stated');
  if (!/PDF/i.test(t)) throw new Error('accepted types are not stated');
});

await step('the privacy page discloses the third-party AI processing', async () => {
  await go('/privacy');
  const t = await page.locator('body').innerText();
  for (const must of [/Google/i, /Gemini/i, /optional/i]) if (!must.test(t))
    throw new Error('privacy page missing disclosure: ' + must);
});

await b.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n=== UPLOAD / AI DISCLOSURE (browser, demo mode) ===');
let f = 0;
for (const [n, ok, note] of results) { console.log(`  ${ok?'PASS':'FAIL'}  ${n}${note?'\n          '+note:''}`); if(!ok) f++; }
console.log(`\n${results.length-f}/${results.length} passed · ${errs.length} page errors`);
errs.slice(0,4).forEach(e => console.log('  ' + e));

process.exit(f ? 1 : 0);
