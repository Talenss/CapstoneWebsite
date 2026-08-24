/* ============================================================
   ResumeMatch PH — configuration
   ------------------------------------------------------------
   The ONLY file you edit when moving between machines or hosts.
   Values may be overridden by environment variables of the same
   name (put them in .env).
   ============================================================ */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ---------- Database (Supabase / PostgreSQL) ----------
// The easiest way: paste your Supabase connection string into
// DATABASE_URL in .env (Project → Settings → Database → "Session
// pooler" connection string). Everything else is a fallback for a
// local Postgres during development.
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const DB_HOST = process.env.DB_HOST || '127.0.0.1';
export const DB_NAME = process.env.DB_NAME || 'resumematch_ph';
export const DB_USER = process.env.DB_USER || 'postgres';
export const DB_PASS = process.env.DB_PASS || '';
export const DB_PORT = Number(process.env.DB_PORT || 5432);
// Supabase always needs SSL; a plain local Postgres usually doesn't.
// Defaults to on whenever a DATABASE_URL is set. Override with DB_SSL.
export const DB_SSL = (process.env.DB_SSL || (DATABASE_URL ? 'true' : 'false')) === 'true';

export const PORT = Number(process.env.PORT || 4300);

// Applicant resume files. Kept out of any public web root and served only
// through /api/file.php-equivalent, which checks who's asking.
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
export const MAX_UPLOAD = 2 * 1024 * 1024; // 2 MB
export const ALLOWED_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/* ---------- where uploaded resume files live ----------
   Set SUPABASE_URL and SUPABASE_SERVICE_KEY and uploads go to Supabase
   Storage; leave either empty and they stay in UPLOAD_DIR on local disk.

   This matters in production: most Node hosts give the process an ephemeral
   filesystem, so a redeploy or a restart silently empties UPLOAD_DIR while
   the database rows that point at those files survive. See lib/storage.ts.

   SUPABASE_SERVICE_KEY is the SERVICE ROLE key, which bypasses row-level
   security — it belongs on the server only and must never reach the browser.
   The bucket must be PRIVATE: reads are authorised by routes/file.ts, and a
   public bucket would make every resume reachable by guessing a URL. */
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
export const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'resumes';

// The Angular dev server origin, so cookie-based sessions work cross-origin in dev.
export const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'http://localhost:4200';

/* NODE_ENV=production is the signal that this is a real deployment rather
   than someone's laptop. It flips the two defaults that are convenient in
   development and dangerous in the open. */
export const IS_PROD = process.env.NODE_ENV === 'production';

/* DEBUG echoes raw error text to clients AND returns live email
   verification codes in API responses — with it on, anyone could register
   or take over any address without access to the inbox. It must never
   default to on in production. */
export const DEBUG = (process.env.DEBUG || (IS_PROD ? 'false' : 'true')) === 'true';

const DEV_SESSION_SECRET = 'rmph-dev-secret-change-in-production';
export const SESSION_SECRET = process.env.SESSION_SECRET || DEV_SESSION_SECRET;

const COOKIE_SECURE_RAW = process.env.COOKIE_SECURE === 'true';

/* Deployments forget .env files. Refusing to start is the only thing loud
   enough to be noticed — a warning in a log nobody reads is not. Signed
   sessions with a secret published in a public repository are forgeable, so
   this is not a configuration nicety. */
if (IS_PROD) {
  const problems: string[] = [];
  if (SESSION_SECRET === DEV_SESSION_SECRET)
    problems.push('SESSION_SECRET is still the development default — session cookies would be forgeable. Set it to a long random string.');
  if (DEBUG)
    problems.push('DEBUG is on in production — it returns email verification codes in API responses. Set DEBUG=false.');
  if (!COOKIE_SECURE_RAW)
    problems.push('COOKIE_SECURE is not set — the session cookie would be sent over plain HTTP. Set COOKIE_SECURE=true when serving over HTTPS.');
  if (problems.length) {
    console.error('\nRefusing to start in production with an unsafe configuration:\n');
    for (const p of problems) console.error('  · ' + p);
    console.error('\nSee SETUP.md, "Going live checklist".\n');
    process.exit(1);
  }
}

// ---------- production hardening (see SETUP.md, "Going live checklist") ----------
// Behind an HTTPS reverse proxy set BOTH to true: TRUST_PROXY makes
// Express believe the proxy's X-Forwarded-* headers (real client IPs for
// rate limiting, https detection), COOKIE_SECURE marks the session cookie
// HTTPS-only. Leave false for plain-http local development.
export const TRUST_PROXY = (process.env.TRUST_PROXY || 'false') === 'true';
export const COOKIE_SECURE = COOKIE_SECURE_RAW;

// ---------- AI resume analysis (optional) ----------
// The "Upload & analyze" feature reads an uploaded resume with Google's
// Gemini API (free tier) and prefills the structured resume builder.
// Without a key, the feature shows a friendly "not configured" message;
// everything else on the site keeps working. Get a free key at
// https://aistudio.google.com/apikey and put it in .env.
/* ---------- resume reading ----------
   Which reader turns an uploaded document into structured fields:

     'rules'   lib/parse-resume.ts — regular expressions, section headings and
               the skill vocabulary. No network, no model, no data leaves the
               server. Cannot read a scan or a photo.
     'gemini'  lib/extract.ts — Google's Gemini API. Reads images, and reads
               messy layouts better, but sends the applicant's document to a
               third party and needs a key.
     'auto'    gemini when a key is configured, rules otherwise. The default,
               so an existing deployment keeps its behaviour and a keyless one
               gains reading it did not have.

   Set RESUME_EXTRACTOR=rules to run the study without any AI at all.

   Set RESUME_EXTRACTOR=escalate to try the rules reader FIRST and call the
   model only for the documents it could not read. 'auto' spends a request on
   every upload, including the plain single-column ones the rules reader
   handles perfectly; 'escalate' spends one only where the free reader came
   back thin. See thinReading() in lib/extract.ts for what "thin" means. */
export type ExtractorMode = 'rules' | 'gemini' | 'auto' | 'escalate';

/** Read at the point of use rather than frozen at import. The study compares
 *  the two readers over the same set of files by flipping this setting between
 *  runs, so the value has to be readable when the reader is chosen, not only
 *  when the process booted. */
export function resumeExtractorMode(): ExtractorMode {
  const raw = (process.env.RESUME_EXTRACTOR || 'auto').trim().toLowerCase();
  return raw === 'rules' || raw === 'gemini' || raw === 'escalate' ? raw : 'auto';
}

/** Read at the point of use, for the same reason resumeExtractorMode() is:
 *  the study flips between the two readers between runs, and a key frozen at
 *  import made activeExtractor() only half-live — the mode responded to a
 *  change and the key did not, so the two could disagree about which reader
 *  was configured. A test caught this. */
export const geminiApiKey = (): string => process.env.GEMINI_API_KEY || '';
/* NOT gemini-2.5-flash, which this defaulted to until an API key issued in
   2026 could not call it: Google has closed that model to new keys, and the
   request comes back 404 "no longer available to new users". It is a confusing
   failure to inherit, because the model still appears in the /models listing
   and an older key still works — so it fails only for whoever sets the project
   up next. Pinned to an exact version rather than the gemini-flash-latest
   alias, which moves when Google ships a new model and would change extraction
   results in the middle of data collection. */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
/* The API host. Overridable so the extraction route can be tested against a
   local stand-in — the value of those tests is in OUR code (the multipart
   handling, the MIME check, and the coercion of whatever the model returns),
   none of which should require a paid key or a network round trip to verify. */
export const geminiBaseUrl = (): string =>
  process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

// ---------- Email sending (verification codes, password reset) ----------
// Any SMTP service works: Gmail with an "app password", Brevo's free tier,
// Outlook, etc. — see SETUP.md. Without SMTP settings the email features
// tell the user email isn't configured; with DEBUG=true the code is also
// printed to this server's console so development works without SMTP.
export const SMTP_HOST = process.env.SMTP_HOST || '';
export const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
export const SMTP_SECURE = (process.env.SMTP_SECURE || (SMTP_PORT === 465 ? 'true' : 'false')) === 'true';
export const SMTP_USER = process.env.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || '';
export const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? `ResumeMatch PH <${SMTP_USER}>` : '');
/* Public base URL of the site, used for the links inside notification and
   verification emails.

   RENDER_EXTERNAL_URL is set by Render itself to the service's full https
   URL. Falling back to it means a deployment that forgets APP_URL still
   sends working links, rather than emailing every participant a localhost
   address — a failure nobody sees until someone clicks one. An explicit
   APP_URL still wins, which is what a custom domain needs. */
export const APP_URL = (
  process.env.APP_URL
  || process.env.RENDER_EXTERNAL_URL
  || `http://localhost:${PORT}`
).replace(/\/$/, '');
