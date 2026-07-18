/* ResumeMatch PH — scripts/create-admin.ts
   Creates (or resets) the research-team admin account that reviews
   recruiter requests at /admin. Deliberately a command-line step — there
   is no self-serve path to the admin role.

     npm run create-admin -- admin@your-email.com "a strong password"
*/
import bcrypt from 'bcryptjs';
import { db, queryOne, exec } from '../src/db';
import { runMigrations } from '../src/lib/migrate';

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: npm run create-admin -- <email> <password>');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('Use a password of at least 6 characters.');
    process.exit(1);
  }

  await runMigrations(); // so this works even before the server's first boot
  const hash = await bcrypt.hash(password, 10);
  const existing = await queryOne<{ user_id: number; role: string }>(
    'SELECT user_id, role FROM users WHERE email = ? LIMIT 1', [email],
  );

  if (existing) {
    if (existing.role !== 'admin') {
      console.error(`${email} already exists with role '${existing.role}' — refusing to change an existing account's role.`);
      process.exit(1);
    }
    await exec('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, existing.user_id]);
    console.log(`Password updated for existing admin ${email}.`);
  } else {
    await exec(
      "INSERT INTO users (role, full_name, email, password_hash, verified) VALUES ('admin', 'Research Team', ?, ?, 1)",
    [email, hash],
    );
    console.log(`Admin account created: ${email}`);
    console.log(`Log in at /auth and open /admin to review recruiter requests.`);
  }
  await db().end();
}

main().catch((e) => {
  console.error('Failed:', e?.message || e);
  console.error('(Is MySQL running, and are the DB_* settings in .env correct?)');
  process.exit(1);
});
