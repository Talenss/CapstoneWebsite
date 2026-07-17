/* ============================================================
   ResumeMatch PH — configuration
   ------------------------------------------------------------
   The ONLY file you edit when moving between machines or hosts.
   Mirrors 04_Website/api/config.php. Values may be overridden by
   environment variables of the same name.
   ============================================================ */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export const DB_HOST = process.env.DB_HOST || '127.0.0.1';
export const DB_NAME = process.env.DB_NAME || 'resumematch_ph';
export const DB_USER = process.env.DB_USER || 'root';
export const DB_PASS = process.env.DB_PASS || '';
export const DB_PORT = Number(process.env.DB_PORT || 3306);

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

// The Angular dev server origin, so cookie-based sessions work cross-origin in dev.
export const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'http://localhost:4200';

export const DEBUG = (process.env.DEBUG || 'true') === 'true';

export const SESSION_SECRET = process.env.SESSION_SECRET || 'rmph-dev-secret-change-in-production';

// ---------- AI resume analysis (optional) ----------
// The "Upload & analyze" feature reads an uploaded resume with Google's
// Gemini API (free tier) and prefills the structured resume builder.
// Without a key, the feature shows a friendly "not configured" message;
// everything else on the site keeps working. Get a free key at
// https://aistudio.google.com/apikey and put it in .env.
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
