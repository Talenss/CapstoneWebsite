/* Linaw PH — scripts/create-admin.ts
   Creates (or resets) the admin account of a partner company's HEAD OF
   RECRUITMENT, who reviews that company's recruiter requests at /admin.
   Deliberately a command-line step — there is no self-serve path to the
   admin role, and every admin belongs to exactly one company.

     npm run create-admin -- head@company.com "a strong password" "Clark Outsourcing"
     npm run create-admin -- head@company.com "a strong password" "Clark Outsourcing" "Maria" "Santos"

   The company must already exist; the script lists the ones that do if the
   name does not match. Running it again for the same email resets the
   password and re-links the company.
*/
import bcrypt from 'bcryptjs';
import { db, query, queryOne, exec } from '../src/db';
import { runMigrations } from '../src/lib/migrate';
import { passwordProblem } from '../src/lib/password';

const TITLE = 'Head of Recruitment';

async function main(): Promise<void> {
  const [email, password, companyName, firstName, lastName] = process.argv.slice(2);
  if (!email || !password || !companyName) {
    console.error('Usage: npm run create-admin -- <email> <password> "<company name>" ["First name" "Last name"]');
    process.exit(1);
  }
  const pwErr = passwordProblem(password);
  if (pwErr) {
    console.error(pwErr);
    process.exit(1);
  }

  await runMigrations(); // so this works even before the server's first boot

  const company = await queryOne<{ company_id: number; company_name: string }>(
    'SELECT company_id, company_name FROM companies WHERE LOWER(TRIM(company_name)) = LOWER(TRIM(?)) LIMIT 1',
    [companyName],
  );
  if (!company) {
    const all = await query<{ company_name: string }>('SELECT company_name FROM companies ORDER BY company_name');
    console.error(`No partner company is called "${companyName}". The companies on file are:`);
    for (const c of all) console.error(`  - ${c.company_name}`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const existing = await queryOne<{ user_id: number; role: string }>(
    'SELECT user_id, role FROM users WHERE email = ? LIMIT 1', [email],
  );

  if (existing) {
    if (existing.role !== 'admin') {
      console.error(`${email} already exists with role '${existing.role}' — refusing to change an existing account's role.`);
      process.exit(1);
    }
    await exec(
      'UPDATE users SET password_hash = ?, company_id = ?, position_title = ? WHERE user_id = ?',
      [hash, company.company_id, TITLE, existing.user_id],
    );
    console.log(`Updated ${email}: password reset, head of recruitment for ${company.company_name}.`);
  } else {
    await exec(
      `INSERT INTO users (role, first_name, last_name, email, password_hash, company_id, position_title, verified)
       VALUES ('admin', ?, ?, ?, ?, ?, ?, 1)`,
      [firstName || TITLE, lastName || '', email, hash, company.company_id, TITLE],
    );
    console.log(`Head of recruitment for ${company.company_name} created: ${email}`);
    console.log('Log in at /auth and open /admin to review your company\'s recruiter requests.');
  }
  await db().end();
}

main().catch((e) => {
  console.error('Failed:', e?.message || e);
  console.error('(Is PostgreSQL reachable, and are DATABASE_URL / the DB_* settings in .env correct?)');
  process.exit(1);
});
