/* ResumeMatch PH — routes/companies.ts : list · get · update */
import { asyncRouter } from '../lib/async-router';
import { query, queryOne, exec } from '../db';
import { CompanyRow } from '../types';
import { ok, fail, idOf } from '../lib/http';
import { requireRole } from '../lib/auth';
import { serializeCompany } from '../lib/serializers';

const router = asyncRouter();

router.post('/list', async (_req, res) => {
  const rows = await query<CompanyRow>('SELECT * FROM companies ORDER BY company_name');
  ok(res, { companies: rows.map(serializeCompany) });
});

router.post('/get', async (req, res) => {
  const c = await queryOne<CompanyRow>('SELECT * FROM companies WHERE company_id = ?', [idOf(req.body?.id)]);
  if (!c) return fail(res, 'Company not found.');
  ok(res, { company: serializeCompany(c) });
});

router.post('/update', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const id = idOf(req.body?.id);
  // A recruiter may only edit their OWN company.
  if (id !== u.company_id) return fail(res, 'You can only edit your own company profile.', 403);

  /* A genuine partial update. The adapter's contract is Partial<Company>,
     but this used to overwrite all five columns with '' for anything the
     caller omitted — so a client sending only { name } silently blanked the
     industry, location, about and website. Only fields actually present are
     touched now, and each is clamped to its column width (a 200-character
     name previously threw inside the handler and, before the async-router
     fix, took the process down). */
  const COLUMNS: Record<string, { col: string; max: number }> = {
    name: { col: 'company_name', max: 160 },
    industry: { col: 'industry', max: 120 },
    location: { col: 'location', max: 160 },
    about: { col: 'about', max: 4000 },
    website: { col: 'website', max: 200 },
  };

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, { col, max }] of Object.entries(COLUMNS)) {
    if (req.body?.[field] === undefined) continue;
    const value = String(req.body[field] ?? '').trim().slice(0, max);
    if (field === 'name' && value === '') return fail(res, 'The company needs a name.');
    sets.push(`${col}=?`);
    values.push(value);
  }

  if (!sets.length) return fail(res, 'Nothing to update.');
  values.push(id);
  await exec(`UPDATE companies SET ${sets.join(', ')} WHERE company_id=?`, values);
  ok(res);
});

export default router;
