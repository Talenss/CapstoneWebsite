/* ============================================================
   ResumeMatch PH — scripts/go-live.ts
   ------------------------------------------------------------
   Turns a database seeded from db/resumematch_ph.sql into one
   fit to put in front of real people.

   THE PROBLEM THIS SOLVES. That file seeds seven demonstration
   accounts which all share the password `demo123` — and one of
   them, admin@demo.ph, approves recruiter access. The hash is
   committed to a public repository, so those are not
   credentials, they are published facts. Importing the schema
   and then exposing the site means anyone can sign in as the
   administrator.

   WHAT IT REMOVES
     · the seven @demo.ph accounts, and everything owned by
       them — resumes, uploads, applications, saved jobs
     · the seeded job postings, which are illustrative openings
       rather than real vacancies

   WHAT IT KEEPS
     · the schema
     · the canonical skill vocabulary — real reference data the
       matching engine reads
     · match_settings, which holds the published weights and
       tier thresholds
     · the partner company row, so a real recruiter can be
       attached to it

   Nothing is deleted without being counted and shown first.
   The default is a DRY RUN; pass --yes to actually delete.

       npm run go-live           # report only, changes nothing
       npm run go-live -- --yes  # perform the deletions

   Afterwards there is no administrator, which is deliberate —
   create your own, with a password of your choosing:

       npm run create-admin -- you@example.com "a strong password"
   ============================================================ */
import 'dotenv/config';
import { db, query, exec } from '../src/db';
import { deleteFile } from '../src/lib/storage';

const APPLY = process.argv.includes('--yes');

async function main(): Promise<void> {
  console.log(`\nResumeMatch PH — go live  ${APPLY ? '(APPLYING CHANGES)' : '(dry run — nothing will be deleted)'}\n`);

  const demoUsers = await query<{ user_id: number; role: string; email: string }>(
    "SELECT user_id, role, email FROM users WHERE email LIKE '%@demo.ph' ORDER BY user_id");

  if (!demoUsers.length) {
    console.log('  No @demo.ph accounts found — this database is already clean.');
  } else {
    console.log(`  ${demoUsers.length} demonstration account(s) to remove:`);
    for (const u of demoUsers) console.log(`    ${u.role.padEnd(10)} ${u.email}`);
  }

  const ids = demoUsers.map((u) => u.user_id);
  const list = ids.length ? `(${ids.join(',')})` : '(-1)';

  /* Uploaded files live outside the database — in Supabase Storage or on
     disk — so deleting the row would strand the object. Collect the keys
     while the rows still exist. */
  const files = await query<{ own_file_path: string }>(
    `SELECT own_file_path FROM resumes WHERE user_id IN ${list} AND own_file_path IS NOT NULL`);

  const counts = {
    resumes: (await query<{ n: string }>(`SELECT count(*) n FROM resumes WHERE user_id IN ${list}`))[0].n,
    applications: (await query<{ n: string }>(`SELECT count(*) n FROM applications WHERE seeker_id IN ${list}`))[0].n,
    postings: (await query<{ n: string }>('SELECT count(*) n FROM job_postings'))[0].n,
    uploads: String(files.length),
  };
  console.log('\n  Owned data that goes with them:');
  console.log(`    resumes           ${counts.resumes}`);
  console.log(`    applications      ${counts.applications}`);
  console.log(`    uploaded files    ${counts.uploads}`);
  console.log(`    seeded postings   ${counts.postings}   (all of them — a real recruiter posts their own)`);

  const keep = {
    skills: (await query<{ n: string }>('SELECT count(*) n FROM skills'))[0].n,
    settings: (await query<{ n: string }>('SELECT count(*) n FROM match_settings'))[0].n,
    companies: (await query<{ n: string }>('SELECT count(*) n FROM companies'))[0].n,
  };
  console.log('\n  Kept:');
  console.log(`    skills            ${keep.skills}   (the matching vocabulary)`);
  console.log(`    match_settings    ${keep.settings}   (weights and thresholds)`);
  console.log(`    companies         ${keep.companies}   (so a real recruiter can be attached)`);

  if (!APPLY) {
    console.log('\n  Dry run. Re-run with --yes to apply.\n');
    return;
  }

  /* Order matters only where there is no ON DELETE CASCADE; deleting the
     postings first also removes the applications that reference them. */
  await exec('DELETE FROM job_postings');
  if (ids.length) await exec(`DELETE FROM users WHERE user_id IN ${list}`);
  for (const f of files) await deleteFile(f.own_file_path);

  const leftUsers = (await query<{ n: string }>("SELECT count(*) n FROM users WHERE email LIKE '%@demo.ph'"))[0].n;
  const leftAdmin = (await query<{ n: string }>("SELECT count(*) n FROM users WHERE role = 'admin'"))[0].n;
  const leftPost = (await query<{ n: string }>('SELECT count(*) n FROM job_postings'))[0].n;

  console.log('\n  Done.');
  console.log(`    @demo.ph accounts remaining   ${leftUsers}`);
  console.log(`    job postings remaining        ${leftPost}`);
  console.log(`    administrators remaining      ${leftAdmin}`);
  if (Number(leftUsers) > 0) console.log('\n  WARNING: demonstration accounts survived. Investigate before exposing the site.');
  if (Number(leftAdmin) === 0) {
    console.log('\n  There is now no administrator, which is expected. Create yours:');
    console.log('    npm run create-admin -- you@example.com "a strong password"\n');
  }
}

main()
  .then(() => db().end())
  .catch(async (e) => { console.error('\nFAILED:', e?.message || e, '\n'); await db().end(); process.exit(1); });
