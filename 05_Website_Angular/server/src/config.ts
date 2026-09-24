/* ============================================================
   Linaw PH — configuration
   ------------------------------------------------------------
   The ONLY file you edit when moving between machines or hosts.
   Values may be overridden by environment variables of the same
   name (put them in .env).
   ============================================================ */
import path from 'path';
import dns from 'dns';
import dotenv from 'dotenv';

/* Render has no outbound IPv6, and Node will use whichever record DNS
   returns. This broke sign-up in production: smtp.gmail.com resolved to an
   IPv6 address and every verification email failed with ENETUNREACH, while
   the same host answered fine on IPv4. Costs nothing on a dual-stack
   machine. Must run before any module opens a socket. */
dns.setDefaultResultOrder('ipv4first');


dotenv.config();

// ---------- Database (Supabase / PostgreSQL) ----------
// The easiest way: paste your Supabase connection string into
// DATABASE_URL in .env (Project → Settings → Database → "Session
// pooler" connection string). Everything else is a fallback for a
// local Postgres during development.
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const DB_HOST = process.env.DB_HOST || '127.0.0.1';
export const DB_NAME = process.env.DB_NAME || 'linaw_ph';
export const DB_USER = process.env.DB_USER || 'postgres';
export const DB_PASS = process.env.DB_PASS || '';
export const DB_PORT = Number(process.env.DB_PORT || 5432);
// Supabase always needs SSL; a plain local Postgres usually doesn't.
// Defaults to on whenever a DATABASE_URL is set. Override with DB_SSL.
export const DB_SSL = (process.env.DB_SSL || (DATABASE_URL ? 'true' : 'false')) === 'true';

export const PORT = Number(process.env.PORT || 4300);

// Applicant resume files. Kept out of any public web root and served only
// through routes/file.ts, which authorises every read.
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
export const MAX_UPLOAD = 2 * 1024 * 1024; // 2 MB

/** THE MOST RESUMES ONE APPLICANT CAN KEEP. Twenty, and the reasons are
 *  practical, not a judgement about how many an applicant should want:
 *    · storage — each resume can carry its own 2 MB uploaded file, so twenty
 *      bounds one account at about 40 MB on a free-tier database and bucket;
 *    · the "which resume?" picker when applying stays short enough to read;
 *    · twenty is still more than one tailored resume per opening the
 *      platform typically lists, so nobody is stopped from tailoring.
 *  Reached, the applicant deletes one they no longer use; nothing is lost
 *  silently. Mirrored in client/src/app/core/engine.ts. */
export const MAX_RESUMES = 20;
export const ALLOWED_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/* Set both and uploads go to Supabase Storage; leave either empty and they
   stay on local disk. Render's filesystem is ephemeral, so a redeploy empties
   UPLOAD_DIR while the rows pointing at those files survive (lib/storage.ts).

   SUPABASE_SERVICE_KEY bypasses row-level security: server only, never the
   browser. The bucket must be PRIVATE — routes/file.ts authorises reads, and
   a public bucket would expose every resume to a guessed URL. */
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
export const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'resumes';

// The Angular dev server origin, so cookie-based sessions work cross-origin in dev.
export const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'http://localhost:4200';

// Flips the two defaults that are convenient in development and dangerous
// in the open.
export const IS_PROD = process.env.NODE_ENV === 'production';

// DEBUG returns live email verification codes in API responses, so with it
// on anyone could take over any address without access to the inbox.
export const DEBUG = (process.env.DEBUG || (IS_PROD ? 'false' : 'true')) === 'true';

const DEV_SESSION_SECRET = 'linaw-dev-secret-change-in-production';
export const SESSION_SECRET = process.env.SESSION_SECRET || DEV_SESSION_SECRET;

const COOKIE_SECURE_RAW = process.env.COOKIE_SECURE === 'true';

/* Refusing to start is the only thing loud enough to be noticed; a warning
   in a log nobody reads is not. A session signed with a secret that is in a
   public repository is forgeable. */
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

/** Read at the point of use, not frozen at import: the study flips this
 *  between runs to compare the two readers over the same files. */
export function resumeExtractorMode(): ExtractorMode {
  const raw = (process.env.RESUME_EXTRACTOR || 'auto').trim().toLowerCase();
  return raw === 'rules' || raw === 'gemini' || raw === 'escalate' ? raw : 'auto';
}

/** Live, for the same reason. A key frozen at import made activeExtractor()
 *  half-live: the mode responded to a change and the key did not, so the two
 *  disagreed about which reader was configured. A test caught it. */
export const geminiApiKey = (): string => process.env.GEMINI_API_KEY || '';
/* NOT gemini-2.5-flash: Google closed it to new keys, so a key issued in 2026
   gets 404 "no longer available to new users" while the model still appears in
   /models and older keys still work — it fails only for whoever sets this up
   next. Pinned to an exact version, not the -latest alias, which would change
   extraction results mid-collection. */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
/* Overridable so extraction can be tested against a local stand-in: the value
   of those tests is in our own multipart handling, MIME check and coercion,
   none of which should need a paid key to verify. */
export const geminiBaseUrl = (): string =>
  process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

/* ---------- email ----------
   Render's free instances block SMTP ports 25, 465 and 587, so no SMTP
   provider works there — the connection times out, which reads like a bad
   password and is not one. With BREVO_API_KEY set the mailer posts to Brevo
   over HTTPS instead. SMTP is still the path when this is empty, which is
   what local development and any paid host use. See SETUP.md. */
export const BREVO_API_KEY = process.env.BREVO_API_KEY || '';

export const SMTP_HOST = process.env.SMTP_HOST || '';
export const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
export const SMTP_SECURE = (process.env.SMTP_SECURE || (SMTP_PORT === 465 ? 'true' : 'false')) === 'true';
export const SMTP_USER = process.env.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || '';
export const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? `Linaw PH <${SMTP_USER}>` : '');
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
