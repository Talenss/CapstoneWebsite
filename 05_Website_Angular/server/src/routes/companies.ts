/* ResumeMatch PH — routes/companies.ts : list · get · update */
import { Router } from 'express';
import { query, queryOne, exec } from '../db';
import { CompanyRow } from '../types';
import { ok, fail } from '../lib/http';
import { requireRole } from '../lib/auth';
import { serializeCompany } from '../lib/serializers';

const router = Router();

router.post('/list', async (_req, res) => {
  const rows = await query<CompanyRow>('SELECT * FROM companies ORDER BY company_name');
  ok(res, { companies: rows.map(serializeCompany) });
});

router.post('/get', async (req, res) => {
  const c = await queryOne<CompanyRow>('SELECT * FROM companies WHERE company_id = ?', [Number(req.body?.id)]);
  if (!c) return fail(res, 'Company not found.');
  ok(res, { company: serializeCompany(c) });
});

router.post('/update', async (req, res) => {
  const u = await requireRole(req, res, 'recruiter');
  if (!u) return;
  const id = Number(req.body?.id);
  // A recruiter may only edit their OWN company.
  if (id !== u.company_id) return fail(res, 'You can only edit your own company profile.', 403);

  await exec(
    'UPDATE companies SET company_name=?, industry=?, location=?, about=?, website=? WHERE company_id=?',
    [
      String(req.body?.name ?? '').trim(),
      String(req.body?.industry ?? '').trim(),
      String(req.body?.location ?? '').trim(),
      String(req.body?.about ?? '').trim(),
      String(req.body?.website ?? '').trim(),
      id,
    ],
  );
  ok(res);
});

export default router;
