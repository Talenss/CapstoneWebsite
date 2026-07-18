/* ResumeMatch PH — lib/email-codes.ts
   Storage and rules for the 6-digit email codes (account verification and
   password reset). The table is created automatically at server start, so
   databases imported from the original 04_Website schema need no manual
   migration step. */
import crypto from 'crypto';
import { exec, queryOne } from '../db';
import { CodePurpose } from './mailer';

export const CODE_TTL_MINUTES = 10;
export const RESEND_COOLDOWN_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

export async function ensureEmailCodesTable(): Promise<void> {
  await exec(`CREATE TABLE IF NOT EXISTS email_codes (
    code_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
    email       VARCHAR(190) NOT NULL,
    purpose     ENUM('verify','reset') NOT NULL,
    code        CHAR(6) NOT NULL,
    attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
    expires_at  DATETIME NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (code_id),
    KEY idx_email_purpose (email, purpose)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export type IssueResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

/** Create and store a fresh code, enforcing the resend cooldown and the
 *  per-hour cap. Replaces any previous outstanding code for this
 *  email+purpose so only the newest one is ever valid. */
export async function issueCode(email: string, purpose: CodePurpose): Promise<IssueResult> {
  const recent = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM email_codes
      WHERE email = ? AND purpose = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    [email, purpose],
  );
  if ((recent?.n ?? 0) >= MAX_SENDS_PER_HOUR)
    return { ok: false, error: 'Too many codes requested for this email. Wait an hour and try again.' };

  const justSent = await queryOne(
    `SELECT 1 FROM email_codes
      WHERE email = ? AND purpose = ? AND created_at > DATE_SUB(NOW(), INTERVAL ${RESEND_COOLDOWN_SECONDS} SECOND) LIMIT 1`,
    [email, purpose],
  );
  if (justSent)
    return { ok: false, error: `A code was just sent. Check your inbox (and spam folder), or try again in a minute.` };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await exec('DELETE FROM email_codes WHERE email = ? AND purpose = ? AND expires_at < NOW()', [email, purpose]);
  await exec(
    `INSERT INTO email_codes (email, purpose, code, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ${CODE_TTL_MINUTES} MINUTE))`,
    [email, purpose, code],
  );
  return { ok: true, code };
}

export type CheckResult = { ok: true } | { ok: false; error: string };

/** Validate a submitted code. Consumes it on success; counts attempts and
 *  invalidates after too many wrong tries. */
export async function checkCode(email: string, purpose: CodePurpose, submitted: string): Promise<CheckResult> {
  const row = await queryOne<{ code_id: number; code: string; attempts: number; expired: number }>(
    `SELECT code_id, code, attempts, (expires_at < NOW()) AS expired
       FROM email_codes WHERE email = ? AND purpose = ?
      ORDER BY code_id DESC LIMIT 1`,
    [email, purpose],
  );
  if (!row) return { ok: false, error: 'No code was requested for this email. Use “Resend code” to get one.' };
  if (row.expired) return { ok: false, error: 'That code has expired. Use “Resend code” to get a fresh one.' };
  if (row.attempts >= MAX_ATTEMPTS)
    return { ok: false, error: 'Too many wrong tries for this code. Use “Resend code” to get a fresh one.' };

  const s = String(submitted).trim();
  const wellFormed = /^\d{6}$/.test(s);
  if (!wellFormed || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(row.code))) {
    await exec('UPDATE email_codes SET attempts = attempts + 1 WHERE code_id = ?', [row.code_id]);
    return { ok: false, error: 'That code isn’t right. Check the email and try again.' };
  }

  await exec('DELETE FROM email_codes WHERE email = ? AND purpose = ?', [email, purpose]);
  return { ok: true };
}
