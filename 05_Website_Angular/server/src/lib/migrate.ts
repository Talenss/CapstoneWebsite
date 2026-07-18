/* ResumeMatch PH — lib/migrate.ts
   Additive, self-applying schema upgrades, run once at server start.
   They let a database imported from the original 04_Website schema keep
   working across feature updates with no manual SQL. */
import { exec, queryOne } from '../db';
import { ensureEmailCodesTable } from './email-codes';

export async function runMigrations(): Promise<void> {
  await ensureEmailCodesTable();

  // users.email_notifications — the per-user opt-out for application emails
  const col = await queryOne(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_notifications' LIMIT 1`,
  );
  if (!col) {
    await exec("ALTER TABLE users ADD COLUMN email_notifications TINYINT(1) NOT NULL DEFAULT 1 AFTER verified");
    console.log('[migrate] added users.email_notifications');
  }

  // users.role gains 'admin' — the research-team account that approves
  // recruiter requests (see routes/admin.ts and scripts/create-admin.ts)
  const role = await queryOne<{ COLUMN_TYPE: string }>(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role' LIMIT 1`,
  );
  if (role && !role.COLUMN_TYPE.includes('admin')) {
    await exec("ALTER TABLE users MODIFY COLUMN role ENUM('seeker','recruiter','admin') NOT NULL DEFAULT 'seeker'");
    console.log("[migrate] added 'admin' to users.role");
  }

  // job_postings.application_deadline — optional "apply by" date; past it,
  // the posting stops accepting applications (lazy auto-close, no cron)
  const deadline = await queryOne(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_postings' AND COLUMN_NAME = 'application_deadline' LIMIT 1`,
  );
  if (!deadline) {
    await exec('ALTER TABLE job_postings ADD COLUMN application_deadline DATE NULL AFTER min_experience_months');
    console.log('[migrate] added job_postings.application_deadline');
  }

  // saved_jobs — a seeker's bookmarked openings
  await exec(`CREATE TABLE IF NOT EXISTS saved_jobs (
    user_id     INT NOT NULL,
    posting_id  INT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, posting_id),
    CONSTRAINT fk_saved_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_saved_posting FOREIGN KEY (posting_id) REFERENCES job_postings(posting_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
