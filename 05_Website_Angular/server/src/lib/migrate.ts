/* Linaw PH — lib/migrate.ts
   Additive, self-applying schema upgrades, run once at server start.
   Everything here is idempotent (IF NOT EXISTS / DROP-then-ADD), so a
   database created from db/linaw_ph.sql boots with nothing to do,
   and one carried over from an earlier feature set catches up on boot. */
import { exec, query, withTransaction, Tx } from '../db';
import { ensureEmailCodesTable } from './email-codes';


/* Every Supabase project publishes a REST API, and the publishable key that
   reaches it is public by design. Row level security is what stops a stranger
   reading a table through it; without it the dashboard marks the table
   "Unrestricted", which is precisely what it means.

   This application never uses that API — the browser talks to this server,
   and only this server touches the database, as the owning role, which
   bypasses RLS. So enabling it costs nothing here and closes the door there.

   No policies: RLS with none denies everything, which is the right answer
   for tables only this server should ever read.

   This ASKS THE DATABASE which tables exist rather than working from a list
   written here, and that is the point. The previous version named two
   runtime tables and trusted db/linaw_ph.sql for the rest; when the
   screening-question and certification feature added five tables, nothing
   added them to the schema file's block, and they reached production
   "Unrestricted" — application_answers and resume_links among them, which
   hold what applicants typed. A list that must be updated by hand is a list
   that drifts, and the drift is silent because nothing fails. Enumerating
   pg_tables cannot drift: a table that exists is covered, including the two
   created at runtime (user_sessions by connect-pg-simple, email_codes by
   ensureEmailCodesTable above) that the schema file never sees.

   This is also the path by which an ALREADY DEPLOYED database catches up,
   which is the only path that matters for one that is already running:
   re-running the schema file is not an option once there is data in it. */
async function ensureRowLevelSecurity(): Promise<void> {
  let tables: string[];
  try {
    const rows = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    tables = rows.map((r) => r.tablename);
  } catch (e: any) {
    console.warn('Could not list public tables for RLS:', e?.message || e);
    return;
  }
  for (const t of tables) {
    try {
      /* Already-enabled is a no-op, so this is safe to run on every boot. */
      await exec(`ALTER TABLE IF EXISTS "${t}" ENABLE ROW LEVEL SECURITY`);
    } catch (e: any) {
      /* Not fatal. A local Postgres has no REST API in front of it, so the
         protection is irrelevant there, and refusing to boot over it would
         turn a hardening step into an outage. */
      console.warn(`Could not enable RLS on ${t}:`, e?.message || e);
    }
  }
}

/* set_updated_at() is created by db/linaw_ph.sql without a pinned
   search_path, so every database built before that was fixed still carries
   the mutable form — and, as with RLS above, re-running the schema file is
   not an option once there is data in it. Pinning it here is what reaches
   those.

   The function is SECURITY INVOKER and its body resolves nothing but
   now(), a pg_catalog built-in that is searched implicitly whatever this is
   set to, so there is no privilege path to close and nothing to break. It
   is pinned because a function whose name resolution follows the caller's
   search_path is a shape worth not having, and because Supabase's advisor
   reports the unpinned form as a security finding. */
async function ensureFunctionSearchPath(): Promise<void> {
  try {
    await exec(`ALTER FUNCTION public.set_updated_at() SET search_path = ''`);
  } catch (e: any) {
    /* Non-fatal for the same reason as RLS: a hardening step must not be
       able to stop the server booting. A local Postgres without the
       function at all lands here harmlessly. */
    console.warn('Could not pin search_path on set_updated_at:', e?.message || e);
  }
}

/** Split one stored name into its two parts, for the backfill below.
 *
 *  The last whitespace-separated token is the surname and everything before
 *  it is the given name, which is the Philippine convention and the one the
 *  registration form now asks for directly. "Juan Dela Cruz" therefore keeps
 *  "Dela Cruz" together as the surname only if it was written that way; from
 *  a single stored string there is no way to know, so it becomes "Juan Dela"
 *  and "Cruz". That is why this runs ONCE over rows that predate the split
 *  and never again: every account created after it supplies the two parts
 *  itself, and anyone whose old name divided badly can correct it from their
 *  account page. Guessing is acceptable here only because the alternative is
 *  discarding the name entirely, and because it is correctable. */
function splitName(full: string): [string, string] {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ['Unnamed', ''];
  if (parts.length === 1) return [parts[0].slice(0, 60), ''];
  return [parts.slice(0, -1).join(' ').slice(0, 60), parts[parts.length - 1].slice(0, 60)];
}

/** What state is this table's name column in?
 *
 *    'done'      full_name exists and is GENERATED — the split has run.
 *    'todo'      full_name is a writable column — the split has not run.
 *    'half'      full_name is gone but first_name is there — a previous
 *                attempt died partway. Recoverable, and it MUST be
 *                recovered: a dozen queries select full_name, so the
 *                application is broken until the generated column is back. */
type NameState = 'done' | 'todo' | 'half';

async function nameState(tx: Tx, table: string): Promise<NameState> {
  const cols = await tx.query<{ column_name: string; is_generated: string }>(
    `SELECT column_name, is_generated FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?
        AND column_name IN ('full_name', 'first_name')`,
    [table],
  );
  const full = cols.find((c) => c.column_name === 'full_name');
  if (full) return full.is_generated === 'ALWAYS' ? 'done' : 'todo';
  return cols.some((c) => c.column_name === 'first_name') ? 'half' : 'todo';
}

/** users.full_name and recruiter_requests.full_name become first_name +
 *  last_name, with full_name kept as a GENERATED column.
 *
 *  Registration asks for the two parts separately, so the two parts are what
 *  the database stores. full_name stays because a dozen queries select it to
 *  print a person's name, and because deriving it in the database rather
 *  than in each of them means the display name cannot drift from the parts
 *  it is made of — it is not a second copy, it is the same data spelled out.
 *  Writing to it is now an error, which is the point: there is exactly one
 *  way to change someone's name.
 *
 *  Ordering matters and is not tidiness. The old column has to be read for
 *  the backfill before it can be dropped, and it has to be dropped before
 *  the generated one can take its name. Each step is guarded, so a database
 *  that has already been through this does nothing. */
async function splitUserNames(): Promise<void> {
  for (const table of ['users', 'recruiter_requests']) {
    /* ONE TRANSACTION for the whole table, and this is load-bearing rather
       than tidy. Postgres has transactional DDL, so either every statement
       below lands or none of them do.

       Run as eight separate statements, the window between DROP COLUMN
       full_name and ADD COLUMN full_name is a window in which the deployed
       application is broken: a dozen queries select that column. A process
       that died there — an out-of-memory kill, a restart, a dropped
       connection to the database — would leave the site down AND unable to
       repair itself on the next boot, because the check that decides whether
       to migrate would see no full_name column and skip the table.

       Wrapped, a failure rolls back to the state before the deploy and the
       running application is untouched. */
    await withTransaction(async (tx) => {
      const state = await nameState(tx, table);
      if (state === 'done') return;

      const idCol = table === 'users' ? 'user_id' : 'request_id';
      let split = 0;

      if (state === 'todo') {
        await tx.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS first_name VARCHAR(60)`);
        await tx.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_name VARCHAR(60) NOT NULL DEFAULT ''`);

        const rows = await tx.query<{ id: number; full_name: string }>(
          `SELECT ${idCol} AS id, full_name FROM ${table} WHERE first_name IS NULL`,
        );
        for (const r of rows) {
          const [first, last] = splitName(r.full_name);
          await tx.exec(`UPDATE ${table} SET first_name = ?, last_name = ? WHERE ${idCol} = ?`,
            [first, last, r.id]);
        }
        split = rows.length;

        await tx.exec(`ALTER TABLE ${table} ALTER COLUMN first_name SET NOT NULL`);
        await tx.exec(`ALTER TABLE ${table} DROP COLUMN full_name`);
      }

      await tx.exec(`ALTER TABLE ${table} ADD COLUMN full_name VARCHAR(121)
        GENERATED ALWAYS AS (btrim(first_name || ' ' || last_name)) STORED`);

      console.log(state === 'half'
        ? `Recovered ${table}.full_name (a previous migration had not finished).`
        : `Migrated ${table}.full_name into first_name + last_name (${split} row(s) split).`);
    });
  }
}

/* ONE TITLE PER APPLICANT, as a UNIQUE INDEX — so the database refuses a
   duplicate however it arrives, not only when routes/resumes.ts remembers to
   check.

   A database that predates the rule may ALREADY hold duplicates, and creating
   the index over them would fail and stop the server booting. So, once, in one
   transaction: every applicant's oldest resume keeps its name, and each later
   one with the same name (ignoring case and surrounding spaces) is renamed
   "Name (2)", "Name (3)"... to the first that is free. Nothing is deleted.
   Skipped entirely once the index exists. */
async function ensureUniqueResumeTitles(): Promise<void> {
  const has = await query(
    "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'resumes_user_title_unique'");
  if (has.length) return;

  await withTransaction(async (tx) => {
    const rows = await tx.query<{ resume_id: number; user_id: number; title: string }>(
      'SELECT resume_id, user_id, title FROM resumes ORDER BY user_id, resume_id');
    const key = (t: string) => String(t ?? '').trim().toLowerCase();
    const takenBy = new Map<number, Set<string>>();
    for (const r of rows) {
      if (!takenBy.has(r.user_id)) takenBy.set(r.user_id, new Set());
      takenBy.get(r.user_id)!.add(key(r.title));
    }
    const kept = new Map<number, Set<string>>();
    let renamed = 0;
    for (const r of rows) {
      if (!kept.has(r.user_id)) kept.set(r.user_id, new Set());
      const mine = kept.get(r.user_id)!;
      const taken = takenBy.get(r.user_id)!;
      if (!mine.has(key(r.title))) { mine.add(key(r.title)); continue; }
      const base = String(r.title ?? '').trim() || 'Untitled resume';
      for (let n = 2; ; n++) {
        const suffix = ` (${n})`;
        const candidate = base.slice(0, 120 - suffix.length) + suffix;
        if (!taken.has(key(candidate))) {
          await tx.exec('UPDATE resumes SET title = ? WHERE resume_id = ?', [candidate, r.resume_id]);
          taken.add(key(candidate)); mine.add(key(candidate)); renamed++;
          break;
        }
      }
    }
    await tx.exec('CREATE UNIQUE INDEX resumes_user_title_unique ON resumes (user_id, LOWER(BTRIM(title)))');
    console.log(`Resume titles are now unique per applicant${renamed ? ` (${renamed} duplicate(s) renamed)` : ''}.`);
  });
}

export async function runMigrations(): Promise<void> {
  await ensureEmailCodesTable();
  await ensureRowLevelSecurity();
  await ensureFunctionSearchPath();
  await splitUserNames();

  // users.email_notifications — the per-user opt-out for application emails
  await exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications SMALLINT NOT NULL DEFAULT 1');

  // users.role gains 'admin' — the research-team account that approves
  // recruiter requests (routes/admin.ts, scripts/create-admin.ts). The role
  // column is TEXT with a CHECK constraint; make sure it permits 'admin'.
  await exec('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
  await exec("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('seeker','recruiter','admin'))");

  // applications.status carries the partner's eight-stage pipeline plus
  // 'rejected', 'withdrawn' (a seeker-only action, so the privacy notice's
  // promise that consent can be withdrawn has a real per-application
  // mechanism) and the legacy 'review' (kept valid so rows written before the
  // pipeline was expanded still validate). The status columns are TEXT +
  // CHECK; widen the constraints in place. One list, reused for all three so
  // the two history columns can never drift from the applications column.
  const STATUS_SET =
    "'submitted','scheduling','initial_interview','testing','shortlisted'," +
    "'final_interview','offer','hired','rejected','withdrawn','review'";
  await exec('ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check');
  await exec(`ALTER TABLE applications ADD CONSTRAINT applications_status_check
    CHECK (status IN (${STATUS_SET}))`);
  await exec('ALTER TABLE application_status_history DROP CONSTRAINT IF EXISTS application_status_history_old_status_check');
  await exec(`ALTER TABLE application_status_history ADD CONSTRAINT application_status_history_old_status_check
    CHECK (old_status IN (${STATUS_SET}))`);
  await exec('ALTER TABLE application_status_history DROP CONSTRAINT IF EXISTS application_status_history_new_status_check');
  await exec(`ALTER TABLE application_status_history ADD CONSTRAINT application_status_history_new_status_check
    CHECK (new_status IN (${STATUS_SET}))`);

  // resumes.design — the visual style of the printed resume (ATS-safe skins).
  // Section order still lives in template_type; this only skins the sheet.
  await exec("ALTER TABLE resumes ADD COLUMN IF NOT EXISTS design TEXT NOT NULL DEFAULT 'classic'");
  // Widen the whitelist as designs are added. A database created from an
  // older db/linaw_ph.sql carries the narrower CHECK, which would
  // reject a save the UI happily offers, so the constraint is replaced rather
  // than assumed. Databases upgraded by the line above have no CHECK at all —
  // DROP ... IF EXISTS makes that case a no-op instead of an error.
  await exec('ALTER TABLE resumes DROP CONSTRAINT IF EXISTS resumes_design_check');
  // The eighth design was stored as 'categorized' while every screen called it
  // "Rail". The identifier now matches the name, so rows written under the old
  // one are carried over. This UPDATE must run AFTER the DROP and BEFORE the
  // ADD: put the new constraint on first and every pre-existing 'categorized'
  // row violates it, which fails the migration and, in production, stops the
  // server from booting at all.
  await exec(`UPDATE resumes SET design = 'rail' WHERE design = 'categorized'`);
  await exec(`ALTER TABLE resumes ADD CONSTRAINT resumes_design_check CHECK (design IN (
    'classic','modern','minimal','executive','banner','split','bar','rail',
    'traditional','clean','compact','senior','graduate','technical'))`);

  // resume_skills.evidence_sources — the full list of places a skill was
  // learned, as a JSON array of {kind, ref}. The older evidence_kind/ref pair
  // stays as the first source; existing rows leave this null and the reader
  // falls back to that pair, so nothing needs backfilling.
  await exec('ALTER TABLE resume_skills ADD COLUMN IF NOT EXISTS evidence_sources JSONB');

  // education level gains 'college_level' — the undergraduate/some-college tier
  // the partner asked for (Clark Outsourcing information request, section 5).
  // Both the resume education table and the posting requirement carry the same
  // TEXT + CHECK; widen them in place. One list, reused for both.
  const EDU_SET = "'none','highschool','vocational','associate','college_level','bachelor','master'";
  await exec('ALTER TABLE education DROP CONSTRAINT IF EXISTS education_level_check');
  await exec(`ALTER TABLE education ADD CONSTRAINT education_level_check CHECK (level IN (${EDU_SET}))`);
  await exec('ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS job_postings_education_level_check');
  await exec(`ALTER TABLE job_postings ADD CONSTRAINT job_postings_education_level_check CHECK (education_level IN (${EDU_SET}))`);

  // resumes.own_file_extract — the applicant's own document, read into the
  // same structured shape the builder edits so the engine can score it. The
  // status column is what keeps "we could not read this" distinguishable
  // from "this scored zero"; they mean opposite things to a recruiter.
  await exec('ALTER TABLE resumes ADD COLUMN IF NOT EXISTS own_file_extract JSONB');
  await exec('ALTER TABLE resumes ADD COLUMN IF NOT EXISTS own_file_extract_status TEXT');
  await exec('ALTER TABLE resumes ADD COLUMN IF NOT EXISTS own_file_extract_at TIMESTAMPTZ');

  // resumes.evidence_prompted — whether the applicant was ever ASKED where
  // each skill was used. The builder asks; an import from an uploaded CV
  // does not. Existing rows default to 0, which is right for both cases:
  // a resume already carrying evidence is unaffected (its links score in
  // full regardless), and one carrying none stops being docked for a
  // question it may never have been shown.
  await exec('ALTER TABLE resumes ADD COLUMN IF NOT EXISTS evidence_prompted SMALLINT NOT NULL DEFAULT 0');
  /* Backfill. Before this column existed, "no links at all" was ambiguous —
     it could mean the builder asked and the applicant declined, or that
     nothing ever asked. Only one of those deserves the half-credit penalty,
     and the two are indistinguishable after the fact, so the backfill takes
     the reading that does not penalise an applicant we cannot show was
     asked: prompted where at least one skill carries a source, not prompted
     where none does. A resume with links keeps scoring exactly as it did. */
  await exec(`UPDATE resumes r SET evidence_prompted = 1
                WHERE evidence_prompted = 0
                  AND EXISTS (SELECT 1 FROM resume_skills rs
                               WHERE rs.resume_id = r.resume_id AND rs.evidence_ref IS NOT NULL)`);

  /* The certifications an opening asks for. The weight that scores them is
     added further down, with the CHECK constraint that governs all four —
     one migration owns that constraint, and splitting it was what let a
     later block silently reinstate the three-weight rule. */
  await exec(`CREATE TABLE IF NOT EXISTS posting_certifications (
    posting_id INT NOT NULL REFERENCES job_postings(posting_id) ON DELETE CASCADE,
    cert_name  VARCHAR(160) NOT NULL,
    cert_norm  VARCHAR(160) NOT NULL,
    PRIMARY KEY (posting_id, cert_norm)
  )`);
  // job_postings.application_deadline — optional "apply by" date; past it,
  // the posting stops accepting applications (lazy auto-close, no cron)
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS application_deadline DATE');

  /* job_postings.education_field — which field of study the opening accepts.
     NULLABLE ON PURPOSE, and deliberately NOT given a default: NULL is a
     meaningful third answer ("read it from the department"), which is what
     every opening written before this column existed holds and what keeps
     each of them scoring exactly as it did. A DEFAULT of 'any' would silently
     rewrite that answer for every row in the table. Not a weight column, so
     it stays out of the block that owns posting_weights_complete. */
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS education_field VARCHAR(32)');

  /* What an applicant asks before applying: pay, shift, work setup, where,
     and how many are being hired. All NULLABLE with no default — NULL is
     "the opening does not state it", which is exactly what every existing
     opening says, so none of them changes. A column constraint rides on
     ADD COLUMN IF NOT EXISTS, so a second boot adds nothing twice. */
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS salary_min INT CHECK (salary_min IS NULL OR salary_min >= 0)');
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS salary_max INT CHECK (salary_max IS NULL OR salary_max >= 0)');
  await exec(`ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS shift TEXT
    CHECK (shift IS NULL OR shift IN ('day','mid','night','rotating','flexible'))`);
  await exec(`ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS work_setup TEXT
    CHECK (work_setup IS NULL OR work_setup IN ('onsite','hybrid','remote'))`);
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS work_location VARCHAR(200)');
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS vacancies INT CHECK (vacancies IS NULL OR vacancies BETWEEN 1 AND 999)');
  const range = await query("SELECT 1 FROM pg_constraint WHERE conname = 'job_postings_salary_range'");
  if (!range.length) {
    await exec(`ALTER TABLE job_postings ADD CONSTRAINT job_postings_salary_range
      CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min)`);
  }

  // saved_jobs — a seeker's bookmarked openings
  await exec(`CREATE TABLE IF NOT EXISTS saved_jobs (
    user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    posting_id  INT NOT NULL REFERENCES job_postings(posting_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, posting_id)
  )`);

  // department_assignments — routes a new application's email to the one HR
  // person who owns that posting's department (admin-assigned). A department
  // with no owner falls back to notifying every verified recruiter, so an
  // application is never silently lost. One owner per (company, department).
  await exec(`CREATE TABLE IF NOT EXISTS department_assignments (
    assignment_id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    company_id    INT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
    department    VARCHAR(120) NOT NULL,
    user_id       INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, department)
  )`);

  /* Richer resume records: optional detail on the sections that already
     existed, plus three new optional sections.

     NOTHING here is read by the matching engine. It scores on skills,
     education.level and work_experience.months, and on nothing else —
     which is exactly why a resume can carry far more without disturbing
     the published 50/25/25 formula or a single one of its tests. */
  await exec('ALTER TABLE resumes ADD COLUMN IF NOT EXISTS headline VARCHAR(200)');
  await exec('ALTER TABLE resumes ADD COLUMN IF NOT EXISTS linkedin VARCHAR(300)');
  await exec('ALTER TABLE resumes ADD COLUMN IF NOT EXISTS portfolio VARCHAR(300)');

  await exec('ALTER TABLE education ADD COLUMN IF NOT EXISTS field VARCHAR(160)');
  await exec('ALTER TABLE education ADD COLUMN IF NOT EXISTS location VARCHAR(160)');
  await exec('ALTER TABLE education ADD COLUMN IF NOT EXISTS honors VARCHAR(200)');

  await exec('ALTER TABLE work_experience ADD COLUMN IF NOT EXISTS location VARCHAR(160)');
  await exec('ALTER TABLE work_experience ADD COLUMN IF NOT EXISTS start_date VARCHAR(40)');
  await exec('ALTER TABLE work_experience ADD COLUMN IF NOT EXISTS end_date VARCHAR(40)');
  await exec('ALTER TABLE work_experience ADD COLUMN IF NOT EXISTS is_current SMALLINT NOT NULL DEFAULT 0');
  await exec('ALTER TABLE work_experience ADD COLUMN IF NOT EXISTS bullets TEXT');

  await exec('ALTER TABLE certifications ADD COLUMN IF NOT EXISTS issuer VARCHAR(200)');
  await exec('ALTER TABLE certifications ADD COLUMN IF NOT EXISTS credential_id VARCHAR(120)');

  await exec(`CREATE TABLE IF NOT EXISTS projects (
    project_id   INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    resume_id    INT NOT NULL REFERENCES resumes(resume_id) ON DELETE CASCADE,
    proj_name    VARCHAR(200),
    proj_role    VARCHAR(160),
    start_date   VARCHAR(40),
    end_date     VARCHAR(40),
    description  TEXT,
    link         VARCHAR(300),
    sort_order   INT NOT NULL DEFAULT 0
  )`);
  await exec('CREATE INDEX IF NOT EXISTS idx_proj_resume ON projects (resume_id)');

  await exec(`CREATE TABLE IF NOT EXISTS resume_languages (
    language_id  INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    resume_id    INT NOT NULL REFERENCES resumes(resume_id) ON DELETE CASCADE,
    lang_name    VARCHAR(120),
    proficiency  VARCHAR(120),
    sort_order   INT NOT NULL DEFAULT 0
  )`);
  await exec('CREATE INDEX IF NOT EXISTS idx_lang_resume ON resume_languages (resume_id)');

  await exec(`CREATE TABLE IF NOT EXISTS resume_references (
    reference_id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    resume_id    INT NOT NULL REFERENCES resumes(resume_id) ON DELETE CASCADE,
    ref_name     VARCHAR(160),
    position     VARCHAR(160),
    company      VARCHAR(160),
    email        VARCHAR(190),
    phone        VARCHAR(40),
    sort_order   INT NOT NULL DEFAULT 0
  )`);
  await exec('CREATE INDEX IF NOT EXISTS idx_ref_resume ON resume_references (resume_id)');

  /* job_postings.weight_* — per-opening scoring weights, as whole percentages.
     All three NULL means "use the site defaults" from match_settings, which is
     what every existing posting gets, so this migration changes no score.

     The constraint is enforced here as well as in the route because these
     three numbers scale every score the opening produces: a set totalling 90
     would compress every applicant's score by a tenth and nothing downstream
     would look wrong. The 10 percent floor is policy — a recruiter may
     de-emphasise a criterion but not switch it off, so no applicant is
     measured on a scale that ignores what they have. */
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS weight_skills SMALLINT');
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS weight_education SMALLINT');
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS weight_experience SMALLINT');
  /* The fourth component is added here, with the three it has to total 100
     alongside, because this constraint is owned by one migration and only one.
     An earlier attempt added a second DROP/ADD pair further up; this block
     runs later, so it silently reinstated the three-weight rule and every
     opening that gave certifications a share was refused by the database
     while passing the route's own validation. */
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS weight_certifications SMALLINT');
  /* The other three optional components are declared HERE, beside
     certifications, for the reason the paragraph above gives: the constraint
     below counts them, so they must exist before it is written, and the
     constraint has exactly one owner. Declaring them further down and
     re-creating the constraint there is the very mistake described above —
     and it was made a second time. The later block reinstated a four-component
     rule over this seven-component one, so every opening that weighted
     projects, languages or references was rejected by the database. That
     happens during startup, which meant the server refused to boot. */
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS weight_projects SMALLINT');
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS weight_languages SMALLINT');
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS weight_references SMALLINT');
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS weight_relevance SMALLINT');
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS weight_field SMALLINT');
  await exec('ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS posting_weights_complete');
  await exec(`ALTER TABLE job_postings ADD CONSTRAINT posting_weights_complete CHECK (
    (weight_skills IS NULL AND weight_education IS NULL AND weight_experience IS NULL)
    OR (
      weight_skills IS NOT NULL AND weight_education IS NOT NULL AND weight_experience IS NOT NULL
      AND weight_skills + weight_education + weight_experience
          + COALESCE(weight_certifications, 0) + COALESCE(weight_projects, 0)
          + COALESCE(weight_languages, 0) + COALESCE(weight_references, 0)
          + COALESCE(weight_relevance, 0) + COALESCE(weight_field, 0) = 100
      AND weight_skills >= 10 AND weight_education >= 10 AND weight_experience >= 10
      AND COALESCE(weight_certifications, 0) >= 0 AND COALESCE(weight_projects, 0) >= 0
      AND COALESCE(weight_languages, 0) >= 0 AND COALESCE(weight_references, 0) >= 0
      AND COALESCE(weight_relevance, 0) >= 0 AND COALESCE(weight_field, 0) >= 0
    )
  )`);

  /* WHEN A SKILL FIRST APPEARED ON A RESUME.
     Existing rows get the resume's own created_at rather than today's date:
     stamping every historical skill with the migration's timestamp would tell
     a recruiter that every applicant added every skill on the same day, which
     is both false and exactly the pattern the column exists to surface. A
     resume's creation date is the earliest defensible answer for a skill we
     have no record of. */
  await exec('ALTER TABLE resume_skills ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ');
  await exec(`UPDATE resume_skills rs SET added_at = r.created_at
                FROM resumes r WHERE r.resume_id = rs.resume_id AND rs.added_at IS NULL`);
  await exec('ALTER TABLE resume_skills ALTER COLUMN added_at SET DEFAULT now()');
  await exec(`UPDATE resume_skills SET added_at = now() WHERE added_at IS NULL`);
  await exec('ALTER TABLE resume_skills ALTER COLUMN added_at SET NOT NULL');

  /* WHY a status changed, and the recruiter's own working notes.
     Both are additive and both are optional, so an existing database keeps
     every row it has and every route that never sends them keeps working. */
  await exec(`ALTER TABLE application_status_history ADD COLUMN IF NOT EXISTS reason TEXT`);
  await exec('ALTER TABLE application_status_history DROP CONSTRAINT IF EXISTS status_reason_known');
  await exec(`ALTER TABLE application_status_history ADD CONSTRAINT status_reason_known CHECK (
    reason IS NULL OR reason IN ('not_qualified','failed_requirement','salary_mismatch',
                                 'unreachable','position_filled','stronger_candidate',
                                 'withdrew_interest','other')
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS application_notes (
    note_id        INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    application_id INT NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    author_id      INT REFERENCES users(user_id) ON DELETE SET NULL,
    body           TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await exec('CREATE INDEX IF NOT EXISTS idx_notes_app ON application_notes (application_id)');

  /* WHERE EACH SKILL WAS USED — the entry on the applicant's own resume that
     backs the claim. Both columns are nullable and every existing row gets
     NULL, which is the honest answer: nobody was ever asked.

     That nullability is not free, and the choice is deliberate. A matched
     skill with no source scores at partial credit (lib/engine.ts,
     UNEVIDENCED_CREDIT), so this migration DOES lower the live score of
     resumes saved before the feature existed, until their owner opens the
     builder and fills the sources in. Applications already submitted are
     unaffected: they are ranked on the score snapshotted when they were sent
     (routes/applications.ts), so no decision already made moves underneath
     anybody. Backfilling a guessed source instead would have put words in an
     applicant's mouth and shown a recruiter evidence nobody offered. */
  await exec(`ALTER TABLE resume_skills ADD COLUMN IF NOT EXISTS evidence_kind TEXT`);
  await exec(`ALTER TABLE resume_skills ADD COLUMN IF NOT EXISTS evidence_ref VARCHAR(200)`);
  /* 'document' joined the list when the applicant's own uploaded file became a
     source in its own right. Widening a CHECK is why both names are dropped and
     one is re-added, rather than adding it only when absent: a database built
     before that change carries the narrower rule and would reject the save with
     a 500 the moment an applicant pointed a skill at their own file.

     BOTH names, because there are two. A database created from db/linaw_ph.sql
     gets the inline column CHECK, which Postgres names for itself; one upgraded
     from an older schema gets the named one added below. Dropping only the
     named one left the auto-named rule in place and still narrow — the fresh
     database used by the tests would have passed either way, which is exactly
     why this is spelled out rather than trusted. */
  await exec('ALTER TABLE resume_skills DROP CONSTRAINT IF EXISTS skill_evidence_kind_known');
  await exec('ALTER TABLE resume_skills DROP CONSTRAINT IF EXISTS resume_skills_evidence_kind_check');
  await exec(`ALTER TABLE resume_skills ADD CONSTRAINT skill_evidence_kind_known CHECK (
    evidence_kind IS NULL OR evidence_kind IN ('experience','project','certification','education','document')
  )`);

  /* SKILL CATALOGUE. The seed in db/linaw_ph.sql only runs on a fresh
     database, so a deployed instance would keep whatever catalogue it was
     created with and never see a skill added later. This tops it up instead:
     ON CONFLICT on the unique skill_norm means an existing row is left
     exactly as it is, including a category an administrator changed by hand,
     and only genuinely new skills are inserted. Safe to run on every boot. */
  await exec(`INSERT INTO skills (skill_name, skill_norm, category) VALUES
     ('Active Listening','activelistening','soft'),
     ('CRM Software','crmsoftware','technical'),
     ('Call Handling','callhandling','technical'),
     ('Chat Support','chatsupport','technical'),
     ('Conflict Resolution','conflictresolution','soft'),
     ('Customer Service','customerservice','soft'),
     ('Email Support','emailsupport','technical'),
     ('English Proficiency','englishproficiency','soft'),
     ('Inbound Calls','inboundcalls','technical'),
     ('Outbound Calls','outboundcalls','technical'),
     ('Quality Assurance','qualityassurance','technical'),
     ('Typing Speed','typingspeed','technical'),
     ('Defensive Driving','defensivedriving','technical'),
     ('Delivery Handling','deliveryhandling','technical'),
     ('Professional Driving','professionaldriving','technical'),
     ('Route Planning','routeplanning','technical'),
     ('Safety Compliance','safetycompliance','soft'),
     ('Vehicle Maintenance','vehiclemaintenance','technical'),
     ('Accounts Payable','accountspayable','technical'),
     ('Accounts Receivable','accountsreceivable','technical'),
     ('Auditing','auditing','technical'),
     ('Bank Reconciliation','bankreconciliation','technical'),
     ('Bookkeeping','bookkeeping','technical'),
     ('Financial Reporting','financialreporting','technical'),
     ('Invoicing','invoicing','technical'),
     ('Payroll Processing','payrollprocessing','technical'),
     ('QuickBooks','quickbooks','technical'),
     ('Taxation','taxation','technical'),
     ('Attention to Detail','attentiontodetail','soft'),
     ('Communication','communication','soft'),
     ('Leadership','leadership','soft'),
     ('Problem Solving','problemsolving','soft'),
     ('Teamwork','teamwork','soft'),
     ('Time Management','timemanagement','soft'),
     ('Adobe Illustrator','adobeillustrator','technical'),
     ('Adobe InDesign','adobeindesign','technical'),
     ('Adobe Photoshop','adobephotoshop','technical'),
     ('Branding','branding','technical'),
     ('Canva','canva','technical'),
     ('Copywriting','copywriting','technical'),
     ('Figma','figma','technical'),
     ('Layout Design','layoutdesign','technical'),
     ('Photo Editing','photoediting','technical'),
     ('Social Media','socialmedia','technical'),
     ('Typography','typography','technical'),
     ('Video Editing','videoediting','technical'),
     ('Compensation and Benefits','compensationandbenefits','technical'),
     ('Employee Relations','employeerelations','soft'),
     ('HR Records','hrrecords','technical'),
     ('Labor Law Compliance','laborlawcompliance','technical'),
     ('Onboarding','onboarding','soft'),
     ('Performance Management','performancemanagement','soft'),
     ('Training and Development','traininganddevelopment','soft'),
     ('Active Directory','activedirectory','technical'),
     ('Hardware Repair','hardwarerepair','technical'),
     ('Help Desk Support','helpdesksupport','technical'),
     ('Linux','linux','technical'),
     ('Networking','computernetworking','technical'),
     ('Remote Desktop Support','remotedesktopsupport','technical'),
     ('Software Installation','softwareinstallation','technical'),
     ('Ticketing Systems','ticketingsystems','technical'),
     ('Troubleshooting','troubleshooting','technical'),
     ('Windows','windows','technical'),
     ('Basic Life Support','basiclifesupport','technical'),
     ('First Aid','firstaid','technical'),
     ('Infection Control','infectioncontrol','technical'),
     ('Medical Billing','medicalbilling','technical'),
     ('Medical Records','medicalrecords','technical'),
     ('Medical Terminology','medicalterminology','technical'),
     ('Patient Care','patientcare','technical'),
     ('Pharmacy Assistance','pharmacyassistance','technical'),
     ('Vital Signs Monitoring','vitalsignsmonitoring','technical'),
     ('Data Entry','dataentry','technical'),
     ('Filing and Records','filingandrecords','technical'),
     ('Inventory Management','inventorymanagement','technical'),
     ('MS Office','microsoftoffice','technical'),
     ('Microsoft Excel','microsoftexcel','technical'),
     ('Microsoft Word','microsoftword','technical'),
     ('Minute Taking','minutetaking','technical'),
     ('Office Administration','officeadministration','technical'),
     ('Organization','organization','soft'),
     ('Scheduling','scheduling','soft'),
     ('Supply Management','supplymanagement','technical'),
     ('Travel Arrangements','travelarrangements','technical'),
     ('Applicant Tracking Systems','applicanttrackingsystems','technical'),
     ('Background Checking','backgroundchecking','soft'),
     ('Interviewing','interviewing','soft'),
     ('Job Posting','jobposting','soft'),
     ('Recruitment','recruitment','soft'),
     ('Screening Resumes','screeningresumes','soft'),
     ('Sourcing Candidates','sourcingcandidates','soft'),
     ('Angular','angular','technical'),
     ('Git','git','technical'),
     ('HTML/CSS','htmlcss','technical'),
     ('JavaScript','javascript','technical'),
     ('MySQL','mysql','technical'),
     ('Node.js','nodejs','technical'),
     ('PHP','php','technical'),
     ('REST APIs','restapis','technical'),
     ('React','react','technical'),
     ('Responsive Web Design','responsivewebdesign','technical'),
     ('SQL','sql','technical'),
     ('TypeScript','typescript','technical'),
     ('WordPress','wordpress','technical')
    ON CONFLICT (skill_norm) DO NOTHING`);

  /* ================= THREE FURTHER SCORABLE SECTIONS =================
     Projects, languages and references were stored and printed from the
     beginning but never scored. Each now carries a weight with exactly the
     shape certifications already had: NULL means the same as 0, so every
     opening already in this table keeps the precise score it has always
     produced and nothing needs backfilling.

     min_projects / min_references are counts, scored the way experience is:
     a stated minimum the applicant meets in full or in part, and an unstated
     one (0) contributing a full component rather than a penalty. Languages
     are matched by name, the way certifications are, because a language is
     something an opening either asks for or does not.

     THIS CONSTRAINT MUST STAY THE LAST ONE IN THE FILE TO TOUCH
     posting_weights_complete. An earlier block up the file adds the
     four-weight version; whichever runs last is the rule the database
     enforces, and a four-weight rule here would refuse every opening that
     gives one of the new sections a share while the route happily accepted
     it. That failure has already happened once with certifications — see the
     comment above that block. */
  /* The weight columns and the constraint that counts them belong to the
     weight_* block much further up, which owns them outright. Only the two
     minimum-count columns are added here, because nothing above references
     them. */
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS min_projects INT NOT NULL DEFAULT 0');
  await exec('ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS min_references INT NOT NULL DEFAULT 0');

  /* The languages an opening asks for. Free text and normalised the same way
     certifications are, because there is no catalogue of language names to
     key against the way there is for skills. */
  await exec(`CREATE TABLE IF NOT EXISTS posting_languages (
    posting_id INT NOT NULL REFERENCES job_postings(posting_id) ON DELETE CASCADE,
    lang_name  VARCHAR(80) NOT NULL,
    lang_norm  VARCHAR(80) NOT NULL,
    PRIMARY KEY (posting_id, lang_norm)
  )`);

  /* ================= RECRUITER SCREENING QUESTIONS =================
     Questions the recruiter writes for one opening, which an applicant must
     answer to apply. They are deliberately NOT scored: the compatibility
     score stays arithmetic over resume fields the applicant can see and
     check, and a free-text answer is neither. They exist so a recruiter can
     ask the one or two things a resume never says. */
  await exec(`CREATE TABLE IF NOT EXISTS posting_questions (
    question_id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    posting_id  INT NOT NULL REFERENCES job_postings(posting_id) ON DELETE CASCADE,
    prompt      VARCHAR(300) NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await exec('CREATE INDEX IF NOT EXISTS idx_pq_posting ON posting_questions (posting_id)');

  /* An answer belongs to the application, not the resume: the same applicant
     answering the same question on a different opening is a different answer,
     and editing a resume afterwards must not rewrite what they said when they
     applied. ON DELETE CASCADE from the question is deliberate — a question
     the recruiter removed takes its answers with it rather than leaving
     orphans nothing can render. */
  await exec(`CREATE TABLE IF NOT EXISTS application_answers (
    application_id INT NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    question_id    INT NOT NULL REFERENCES posting_questions(question_id) ON DELETE CASCADE,
    answer_text    TEXT NOT NULL,
    PRIMARY KEY (application_id, question_id)
  )`);

  /* ================= PRIVATE APPLICANT LINKS =================
     Portfolio and certificate URLs the recruiter sees and the printed resume
     never carries. Separate from resumes.portfolio, which IS printed: these
     are deliberately kept off the document so that a long URL cannot break
     the parser-safe layout the whole design protects, while still reaching
     the person doing the screening. */
  await exec(`CREATE TABLE IF NOT EXISTS resume_links (
    link_id    INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    resume_id  INT NOT NULL REFERENCES resumes(resume_id) ON DELETE CASCADE,
    label      VARCHAR(120),
    url        VARCHAR(500) NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0
  )`);
  await exec('CREATE INDEX IF NOT EXISTS idx_rl_resume ON resume_links (resume_id)');

  /* ================= SECTIONS THE APPLICANT SWITCHED OFF =================
     A comma-separated list of section keys, the same delimiter idiom
     work_experience.bullets already uses. Empty string is the default and
     means "show everything", so every resume written before this column
     existed keeps printing exactly as it did.

     A hidden section is left out of the printed document AND out of the
     score. Those two have to move together: a recruiter must be able to read
     the score as a statement about the sheet in front of them, and a section
     they will never see cannot be quietly earning marks. */
  await exec("ALTER TABLE resumes ADD COLUMN IF NOT EXISTS hidden_sections TEXT NOT NULL DEFAULT ''");

  /* ================= CATALOGUE EXPANSION =================
     db/linaw_ph.sql seeds the skill catalogue, but that file only ever runs
     when a database is created from scratch. A database that already exists
     — production included — would otherwise keep the catalogue it was built
     with, and a recruiter there would find the new industries missing from
     the posting form while the code insists they are there.

     ON CONFLICT on skill_norm makes this idempotent: rows already present are
     left exactly as they are, including their category, so re-running the
     migration on every boot changes nothing after the first time. Nothing
     here touches resume_skills or posting_skills, so no existing score can
     move: these are rows nobody has selected yet.

     Skills are only ever ADDED here. Removing one would orphan every resume
     and posting pointing at it, and the foreign keys would refuse. */
  await exec(`INSERT INTO skills (skill_name, skill_norm, category) VALUES
    -- Sales and Marketing
    ('Lead Generation','leadgeneration','technical'),
    ('Cold Calling','coldcalling','technical'),
    ('Sales Presentations','salespresentations','soft'),
    ('Negotiation','negotiation','soft'),
    ('Account Management','accountmanagement','soft'),
    ('Market Research','marketresearch','technical'),
    ('Email Marketing','emailmarketing','technical'),
    ('Search Engine Optimization','searchengineoptimization','technical'),
    ('Google Analytics','googleanalytics','technical'),
    ('Content Writing','contentwriting','technical'),
    ('Upselling','upselling','soft'),
    ('Client Onboarding','clientonboarding','soft'),
    -- Hospitality and Food Service
    ('Food Safety','foodsafety','technical'),
    ('Food Preparation','foodpreparation','technical'),
    ('Housekeeping','housekeeping','technical'),
    ('Guest Relations','guestrelations','soft'),
    ('Front Desk Operations','frontdeskoperations','technical'),
    ('Table Service','tableservice','technical'),
    ('Bartending','bartending','technical'),
    ('Barista Skills','baristaskills','technical'),
    ('Reservations Handling','reservationshandling','technical'),
    ('Sanitation Practices','sanitationpractices','technical'),
    ('Room Inspection','roominspection','technical'),
    -- Security and Safety
    ('Access Control','accesscontrol','technical'),
    ('CCTV Monitoring','cctvmonitoring','technical'),
    ('Incident Reporting','incidentreporting','technical'),
    ('Patrolling','patrolling','technical'),
    ('Emergency Response','emergencyresponse','technical'),
    ('Crowd Control','crowdcontrol','technical'),
    ('Fire Safety','firesafety','technical'),
    ('Occupational Safety','occupationalsafety','technical'),
    -- Logistics and Warehousing
    ('Warehouse Operations','warehouseoperations','technical'),
    ('Stock Control','stockcontrol','technical'),
    ('Order Picking','orderpicking','technical'),
    ('Forklift Operation','forkliftoperation','technical'),
    ('Shipping and Receiving','shippingandreceiving','technical'),
    ('Freight Documentation','freightdocumentation','technical'),
    ('Dispatch Coordination','dispatchcoordination','technical'),
    ('Packing and Labeling','packingandlabeling','technical'),
    -- Education and Training
    ('Lesson Planning','lessonplanning','technical'),
    ('Classroom Management','classroommanagement','soft'),
    ('Curriculum Development','curriculumdevelopment','technical'),
    ('Tutoring','tutoring','soft'),
    ('Student Assessment','studentassessment','technical'),
    ('Instructional Materials','instructionalmaterials','technical'),
    ('Public Speaking','publicspeaking','soft'),
    -- Data and Analytics
    ('Data Analysis','dataanalysis','technical'),
    ('Data Visualization','datavisualization','technical'),
    ('Microsoft Power BI','microsoftpowerbi','technical'),
    ('Google Sheets','googlesheets','technical'),
    ('Statistical Analysis','statisticalanalysis','technical'),
    ('Report Writing','reportwriting','technical'),
    ('Python','python','technical'),
    ('Data Cleaning','datacleaning','technical'),
    -- Engineering and Trades
    ('AutoCAD','autocad','technical'),
    ('Blueprint Reading','blueprintreading','technical'),
    ('Electrical Wiring','electricalwiring','technical'),
    ('Preventive Maintenance','preventivemaintenance','technical'),
    ('Welding','welding','technical'),
    ('Machine Operation','machineoperation','technical'),
    ('Equipment Calibration','equipmentcalibration','technical'),
    ('Technical Drawing','technicaldrawing','technical'),
    -- BPO
    ('Complaint Handling','complainthandling','soft'),
    ('Order Processing','orderprocessing','technical'),
    ('Escalation Handling','escalationhandling','soft'),
    ('After-Call Work','aftercallwork','technical'),
    ('Customer Retention','customerretention','soft'),
    -- Driver
    ('Vehicle Inspection','vehicleinspection','technical'),
    ('Traffic Regulations','trafficregulations','technical'),
    ('Cargo Securing','cargosecuring','technical'),
    ('Fuel Management','fuelmanagement','technical'),
    -- Finance
    ('Xero','xero','technical'),
    ('SAP','sap','technical'),
    ('Financial Analysis','financialanalysis','technical'),
    ('Budgeting','budgeting','technical'),
    ('Cost Accounting','costaccounting','technical'),
    ('Petty Cash Management','pettycashmanagement','technical'),
    -- General
    ('Adaptability','adaptability','soft'),
    ('Critical Thinking','criticalthinking','soft'),
    ('Decision Making','decisionmaking','soft'),
    ('Multitasking','multitasking','soft'),
    ('Interpersonal Skills','interpersonalskills','soft'),
    ('Work Ethic','workethic','soft'),
    ('Stress Management','stressmanagement','soft'),
    -- Graphic Design
    ('Adobe Premiere Pro','adobepremierepro','technical'),
    ('Adobe After Effects','adobeaftereffects','technical'),
    ('Motion Graphics','motiongraphics','technical'),
    ('Logo Design','logodesign','technical'),
    ('Print Production','printproduction','technical'),
    -- HR
    ('Timekeeping','timekeeping','technical'),
    ('HRIS','hris','technical'),
    ('Employee Engagement','employeeengagement','soft'),
    ('Exit Interviews','exitinterviews','technical'),
    ('Job Evaluation','jobevaluation','technical'),
    -- IT Support
    ('Microsoft 365 Administration','microsoft365administration','technical'),
    ('Data Backup','databackup','technical'),
    ('Network Cabling','networkcabling','technical'),
    ('Mobile Device Support','mobiledevicesupport','technical'),
    ('Antivirus Management','antivirusmanagement','technical'),
    ('Server Maintenance','servermaintenance','technical'),
    -- Medical Field
    ('Phlebotomy','phlebotomy','technical'),
    ('Sterilization','sterilization','technical'),
    ('Medical Coding','medicalcoding','technical'),
    ('Nursing Assistance','nursingassistance','technical'),
    ('Laboratory Assistance','laboratoryassistance','technical'),
    -- Office Management
    ('Google Workspace','googleworkspace','technical'),
    ('Document Control','documentcontrol','technical'),
    ('Transcription','transcription','technical'),
    ('Calendar Management','calendarmanagement','technical'),
    ('Business Correspondence','businesscorrespondence','technical'),
    -- Recruitment
    ('Talent Pipelining','talentpipelining','technical'),
    ('Employer Branding','employerbranding','soft'),
    ('Reference Checking','referencechecking','technical'),
    ('Offer Negotiation','offernegotiation','soft'),
    ('Candidate Engagement','candidateengagement','soft'),
    -- Web Development
    ('Vue.js','vuejs','technical'),
    ('Bootstrap','bootstrap','technical'),
    ('Tailwind CSS','tailwindcss','technical'),
    ('MongoDB','mongodb','technical'),
    ('PostgreSQL','postgresql','technical'),
    ('Laravel','laravel','technical'),
    ('Docker','docker','technical')
    ON CONFLICT (skill_norm) DO NOTHING`);

  await ensureUniqueResumeTitles();
}
