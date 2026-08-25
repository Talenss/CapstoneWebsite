/* ============================================================
   ResumeMatch PH — scripts/check-config.ts
   ------------------------------------------------------------
   Answers one question: are the three external services this
   app depends on actually reachable with the credentials in
   .env — the database, email, and the resume reader?

   Each is checked the cheapest way that proves the credential
   works, and NOTHING is written or sent:

     · database — connect, then one read-only query
     · email    — nodemailer's verify(), which opens the SMTP
                  session and authenticates but sends nothing
     · Gemini   — list models, which needs a valid key

   Run it locally before deploying, and in Render's Shell after,
   since the two environments can differ in ways that only show
   up as a confusing runtime error later.

       npm run check:config
   ============================================================ */
import 'dotenv/config';
import { Client } from 'pg';
import nodemailer from 'nodemailer';

const OK = '  ok    ';
const BAD = '  FAIL  ';
const SKIP = '  skip  ';
let failures = 0;
let verified = 0;
let skipped = 0;

function pass(label: string, detail: string) { verified++; console.log(OK + label.padEnd(12) + detail); }
function fail(label: string, detail: string) { failures++; console.log(BAD + label.padEnd(12) + detail); }
function skip(label: string, detail: string) { skipped++; console.log(SKIP + label.padEnd(12) + detail); }

async function checkDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL || '';
  const host = url ? (url.match(/@([^/:]+)/)?.[1] ?? 'unknown host') : '';
  if (!url && !process.env.DB_HOST) return skip('database', 'neither DATABASE_URL nor DB_HOST is set');

  /* The direct Supabase host has been IPv6-only since their IPv4
     deprecation, and several hosts (Render among them) have no outbound
     IPv6. Naming that here turns a bewildering DNS error into an
     instruction, because the fix is to use the session pooler string. */
  if (/^db\..*\.supabase\.co$/.test(host)) {
    console.log(`        note: ${host} is Supabase's DIRECT host, which is IPv6-only.`);
    console.log("        If this fails, use the SESSION POOLER string instead:");
    console.log('        Supabase -> Project Settings -> Database -> Connection string -> Session pooler.');
  }

  const client = url
    ? new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
    : new Client({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASS,
        ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
      });
  try {
    await client.connect();
    const r = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'");
    const n = Number(r.rows[0].n);
    await client.end();
    if (n === 0) fail('database', `connected to ${host}, but the schema is EMPTY — import db/resumematch_ph.sql`);
    else pass('database', `connected to ${host} — ${n} tables`);
  } catch (e: any) {
    fail('database', `${host || 'DB_HOST'} — ${e?.message || e}`);
  }
}

async function checkEmail(): Promise<void> {
  /* Brevo over HTTPS takes precedence, because a host may not be able to
     reach an SMTP port at all — Render's free instances block 25, 465 and
     587 outright, which presents as a connection timeout rather than as
     anything naming a blocked port. */
  const brevo = process.env.BREVO_API_KEY;
  if (brevo) {
    try {
      const res = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': brevo } });
      if (!res.ok) return fail('email', `Brevo rejected the key (HTTP ${res.status}) — ${(await res.text()).slice(0, 120)}`);
      const acct = await res.json() as { email?: string };
      return pass('email', `Brevo API key valid${acct.email ? ` (${acct.email})` : ''} — sending over HTTPS`);
    } catch (e: any) {
      return fail('email', `Brevo unreachable — ${e?.message || e}`);
    }
  }
  const host = process.env.SMTP_HOST;
  if (!host) return skip('email', 'no BREVO_API_KEY and no SMTP_HOST — verification codes cannot be sent');
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host, port,
    secure: (process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')) === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 15000,
  });
  try {
    await transport.verify(); // opens the session and authenticates; sends nothing
    pass('email', `${host}:${port} authenticated as ${process.env.SMTP_USER}`);
  } catch (e: any) {
    const m = String(e?.message || e);
    fail('email', `${host}:${port} — ${m}`);
    if (/Invalid login|Username and Password not accepted|BadCredentials/i.test(m)) {
      console.log('        Gmail needs an APP PASSWORD, not the account password, and');
      console.log('        SMTP_PASS must have the spaces removed (16 characters).');
    }
  }
}

async function checkGemini(): Promise<void> {
  const key = process.env.GEMINI_API_KEY;
  const mode = (process.env.RESUME_EXTRACTOR || 'auto').toLowerCase();
  if (!key) {
    if (mode === 'rules') return skip('gemini', "not needed: RESUME_EXTRACTOR='rules'");
    return skip('gemini', `no key — uploads fall back to the rules reader (mode '${mode}')`);
  }
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    if (!res.ok) return fail('gemini', `HTTP ${res.status} — ${(await res.text()).slice(0, 120)}`);
    const body = await res.json() as { models?: unknown[] };
    pass('gemini', `key valid — ${body.models?.length ?? 0} models, mode '${mode}'`);
  } catch (e: any) {
    fail('gemini', String(e?.message || e));
  }
}

(async () => {
  console.log('\nResumeMatch PH — checking external services\n');
  await checkDatabase();
  await checkEmail();
  await checkGemini();
  /* A skip is not a pass. Everything skipping means no configuration was
     found at all — almost always a missing .env — and reporting that as
     success would send someone to deploy on the strength of a check that
     verified nothing. */
  if (failures) {
    console.log(`\n${failures} check(s) failed — see above.\n`);
    process.exit(1);
  }
  if (verified === 0) {
    console.log('\nNOTHING WAS CHECKED. All three were skipped, which means no');
    console.log('configuration was found — usually a missing .env file in this folder.');
    console.log('Copy .env.example to .env and fill it in, or set the variables in');
    console.log('the environment before running this.\n');
    process.exit(1);
  }
  console.log(`\n${verified} check(s) passed${skipped ? `, ${skipped} skipped` : ''}.\n`);
  process.exit(0);
})();
