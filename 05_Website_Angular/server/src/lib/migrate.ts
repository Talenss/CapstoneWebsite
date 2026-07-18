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
}
