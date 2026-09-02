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

   Two tables are handled here rather than in db/linaw_ph.sql because
   they are created at runtime — user_sessions by connect-pg-simple on first
   boot, email_codes by ensureEmailCodesTable above — so the schema file
   never sees them. The rest are covered there. This is also the path by
   which a database imported before RLS was added catches up. */
async function ensureRowLevelSecurity(): Promise<void> {
  const runtimeTables = ['user_sessions', 'email_codes'];
  for (const t of runtimeTables) {
    try {
      await exec(`ALTER TABLE IF EXISTS ${t} ENABLE ROW LEVEL SECURITY`);
    } catch (e: any) {
      /* Not fatal. A local Postgres has no REST API in front of it, so the
         protection is irrelevant there, and refusing to boot over it would
         turn a hardening step into an outage. */
      console.warn(`Could not enable RLS on ${t}:`, e?.message || e);
    }
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

export async function runMigrations(): Promise<void> {
  await ensureEmailCodesTable();
  await ensureRowLevelSecurity();
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
  await exec(`ALTER TABLE resumes ADD CONSTRAINT resumes_design_check CHECK (design IN (
    'classic','modern','minimal','executive','banner','split','bar','categorized',
    'traditional','clean','compact','senior','graduate','technical'))`);

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
  await exec('ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS posting_weights_complete');
  await exec(`ALTER TABLE job_postings ADD CONSTRAINT posting_weights_complete CHECK (
    (weight_skills IS NULL AND weight_education IS NULL AND weight_experience IS NULL)
    OR (
      weight_skills IS NOT NULL AND weight_education IS NOT NULL AND weight_experience IS NOT NULL
      AND weight_skills + weight_education + weight_experience
          + COALESCE(weight_certifications, 0) = 100
      AND weight_skills >= 10 AND weight_education >= 10 AND weight_experience >= 10
      AND COALESCE(weight_certifications, 0) >= 0
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
}
