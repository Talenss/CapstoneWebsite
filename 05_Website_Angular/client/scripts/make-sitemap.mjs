/* ResumeMatch PH — sitemap + robots finaliser
   ------------------------------------------------------------------
   Runs after `ng build`. Writes dist/…/sitemap.xml and fixes up the
   Sitemap: line in dist/…/robots.txt.

   WHY THIS IS A BUILD STEP AND NOT A CHECKED-IN FILE

   Both files need the site's ABSOLUTE origin — the sitemap protocol
   requires fully-qualified URLs, and so does the Sitemap: directive in
   robots.txt. A canonical origin is a deployment fact, not a source
   fact: the same build runs on localhost, on Vercel preview URLs and
   on whatever domain the study finally uses.

   So the origin comes from SITE_URL at build time:

       SITE_URL=https://resumematch.ph npm run build:demo

   WITHOUT SITE_URL this writes NO sitemap and strips the Sitemap: line
   out of robots.txt. That is deliberate. A sitemap listing URLs on the
   wrong domain is worse than no sitemap at all: every URL in it 404s,
   and a sitemap full of 404s is a quality signal against the site. An
   absent sitemap costs nothing by comparison — Google finds four
   linked pages without one.
   ------------------------------------------------------------------ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'dist', 'client', 'browser');

if (!existsSync(out)) {
  console.error('sitemap: no build output at ' + out + ' — run the build first.');
  process.exit(1);
}

/** The public pages, in the order they matter. Anything behind a login is
 *  absent on purpose: a sitemap is a list of pages you want indexed, and a
 *  page that redirects to /auth is not one. */
const PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/browse', changefreq: 'daily', priority: '0.9' },
  { path: '/learning-hub', changefreq: 'monthly', priority: '0.8' },
  { path: '/auth', changefreq: 'yearly', priority: '0.5' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
];

const raw = (process.env.SITE_URL || '').trim().replace(/\/$/, '');
const robotsPath = join(out, 'robots.txt');

if (!raw) {
  if (existsSync(robotsPath)) {
    const cleaned = readFileSync(robotsPath, 'utf8')
      .replace(/^# Absolute URL required[\s\S]*?^Sitemap: .*$\n?/m, '')
      .replace(/^Sitemap: .*$\n?/m, '');
    writeFileSync(robotsPath, cleaned);
  }
  console.log('sitemap: SITE_URL not set — no sitemap written, robots.txt Sitemap: line removed.');
  console.log('sitemap: set SITE_URL=https://your-domain to publish one.');
  process.exit(0);
}

if (!/^https?:\/\/[^/\s]+$/.test(raw)) {
  console.error(`sitemap: SITE_URL must be a bare origin like https://resumematch.ph — got ${JSON.stringify(raw)}`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((p) => `  <url>
    <loc>${raw}${p.path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
writeFileSync(join(out, 'sitemap.xml'), xml);

if (existsSync(robotsPath)) {
  const fixed = readFileSync(robotsPath, 'utf8').replace(/^Sitemap: .*$/m, `Sitemap: ${raw}/sitemap.xml`);
  writeFileSync(robotsPath, fixed);
}

console.log(`sitemap: wrote ${PAGES.length} URLs under ${raw}`);
