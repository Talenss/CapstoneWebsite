import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 2047, height: 1111 }, deviceScaleFactor: 1 });
await p.goto('file://' + process.argv[2]);
await p.waitForTimeout(400);
await p.screenshot({ path: process.argv[3] });
await b.close();
console.log('rendered', process.argv[3]);
