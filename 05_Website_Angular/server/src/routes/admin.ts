/* ResumeMatch PH — routes/admin.ts
   The research-team side of "recruiter accounts are provisioned, not
   self-served". An admin reviews the requests that the auth page's
   recruiter form creates, and approving one is what actually creates the
   verified recruiter account. Admin accounts are made with
   `npm run create-admin` — there is deliberately no self-serve path. */
import { asyncRouter } from '../lib/async-router';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, queryOne, exec } from '../db';
import { UserRow } from '../types';
import { ok, fail, idOf } from '../lib/http';
import { requireRole } from '../lib/auth';
import { ts } from '../lib/serializers';
import { APP_URL, DEBUG } from '../config';
import { mailConfigured, sendMail } from '../lib/mailer';

const router = asyncRouter();

interface RequestRow {
  request_id: number;
  first_name: string;
  last_name: string;
  /** Derived in the database from the two parts above; read-only. */
  full_name: string;
  email: string;
  position_title: string | null;
  company_id: number | null;
  company_name: string | null;
  note: string | null;
  status: 'pending' | 'approved' | 'declined';
  requested_at: string;
}

const serializeRequest = (r: RequestRow) => ({
  id: String(r.request_id),
  name: r.full_name,
  email: r.email,
  position: r.position_title || '',
  companyId: r.company_id !== null ? String(r.company_id) : null,
  companyName: r.company_name || '—',
  note: r.note || '',
  status: r.status,
  requestedAt: ts(r.requested_at),
});

async function listRequests() {
  const rows = await query<RequestRow>(
    `SELECT r.*, c.company_name FROM recruiter_requests r
       LEFT JOIN companies c ON c.company_id = r.company_id
      ORDER BY (r.status = 'pending') DESC, r.requested_at DESC`,
  );
  return rows.map(serializeRequest);
}

router.post('/requests', async (req, res) => {
  const u = await requireRole(req, res, 'admin');
  if (!u) return;
  ok(res, { requests: await listRequests() });
});

/* Approving a request IS the account creation. The account gets an
   unguessable placeholder password; the approval email tells the person
   to use "Forgot password" to set their own — same proven code flow,
   nothing new to secure. */
router.post('/approve', async (req, res) => {
  const u = await requireRole(req, res, 'admin');
  if (!u) return;
  const id = idOf(req.body?.id);

  const r = await queryOne<RequestRow>(
    `SELECT r.*, c.company_name FROM recruiter_requests r
       LEFT JOIN companies c ON c.company_id = r.company_id
      WHERE r.request_id = ? LIMIT 1`, [id],
  );
  if (!r) return fail(res, 'Request not found.');
  if (r.status !== 'pending') return fail(res, 'This request was already handled.');
  if (!r.company_id) return fail(res, 'This request has no partner company attached.');

  const existing = await queryOne('SELECT 1 FROM users WHERE email = ? LIMIT 1', [r.email]);
  if (existing) return fail(res, 'An account already uses this email. Decline the request instead.');

  const placeholder = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  await exec(
    `INSERT INTO users (role, first_name, last_name, email, password_hash, company_id, position_title, verified)
     VALUES ('recruiter', ?, ?, ?, ?, ?, ?, 1)`,
    [r.first_name, r.last_name, r.email, placeholder, r.company_id, r.position_title || 'Recruiter'],
  );
  await exec("UPDATE recruiter_requests SET status = 'approved' WHERE request_id = ?", [id]);

  const co = r.company_name || 'your company';
  if (mailConfigured()) {
    sendMail(
      r.email,
      'Your ResumeMatch PH recruiter access is approved',
      `Welcome aboard\n\nYour recruiter account for ${co} is active.\n\nTo set your password: open ${APP_URL}/auth, click "Forgot your password?", enter this email address, and follow the code we send you. After that you can log in and manage your postings.`,
      `
        <h1 style="margin:0 0 10px;font-size:22px">Welcome aboard</h1>
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:#4C5566">Hi ${r.full_name},</p>
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:#4C5566">Your recruiter account for <b>${co}</b> on ResumeMatch PH is now active — verified with your HR department by the research team.</p>
        <p style="margin:0;font-size:14.5px;line-height:1.65;color:#4C5566"><b>One step left — set your password:</b> open the site, choose <b>“Forgot your password?”</b> on the log-in panel, enter this email address, and follow the code we send you. Then log in and your postings are yours to manage.</p>
        <p style="margin:22px 0 0"><a href="${APP_URL}/auth" style="display:inline-block;background:#C9A24B;color:#141926;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:8px">Set my password</a></p>`,
    ).catch((e) => console.error('approval email failed:', e?.message || e));
  } else if (DEBUG) {
    console.log(`[admin] approved ${r.email} — SMTP not configured, tell them to use "Forgot password" to set a password.`);
  }

  ok(res, { requests: await listRequests() });
});

router.post('/decline', async (req, res) => {
  const u = await requireRole(req, res, 'admin');
  if (!u) return;
  const id = idOf(req.body?.id);

  const r = await queryOne<RequestRow>('SELECT * FROM recruiter_requests WHERE request_id = ? LIMIT 1', [id]);
  if (!r) return fail(res, 'Request not found.');
  if (r.status !== 'pending') return fail(res, 'This request was already handled.');

  await exec("UPDATE recruiter_requests SET status = 'declined' WHERE request_id = ?", [id]);

  if (mailConfigured()) {
    sendMail(
      r.email,
      'About your ResumeMatch PH recruiter request',
      `We couldn't verify this request\n\nYour request for recruiter access wasn't approved this time. This usually means the research team couldn't confirm the request with the partner company's HR department. If you believe this is a mistake, please coordinate with your HR and ask them to reach out to the research team.`,
      `
        <h1 style="margin:0 0 10px;font-size:22px">We couldn’t verify this request</h1>
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:#4C5566">Hi ${r.full_name},</p>
        <p style="margin:0;font-size:14.5px;line-height:1.65;color:#4C5566">Your request for recruiter access wasn’t approved this time. This usually means the research team couldn’t confirm the request with the partner company’s HR department. If you believe this is a mistake, please coordinate with your HR and ask them to contact the research team directly.</p>`,
    ).catch((e) => console.error('decline email failed:', e?.message || e));
  } else if (DEBUG) {
    console.log(`[admin] declined request from ${r.email}`);
  }

  ok(res, { requests: await listRequests() });
});

/* ---------- department routing ----------
   Which HR person owns each company department. Assigning an owner means a
   new application for that department emails only them; leaving it unassigned
   means every verified recruiter is emailed (the safe default). Viewing the
   applicant list is unaffected — this only routes the notification. */

interface RoutingCompany {
  id: string;
  name: string;
  departments: string[];
  recruiters: { id: string; name: string }[];
  assignments: { department: string; userId: string; userName: string }[];
}

async function listDeptRouting(): Promise<RoutingCompany[]> {
  // Companies that actually have postings (so there are departments to route).
  const companies = await query<{ company_id: number; company_name: string }>(
    `SELECT DISTINCT c.company_id, c.company_name
       FROM companies c JOIN job_postings jp ON jp.company_id = c.company_id
      ORDER BY c.company_name`,
  );

  const out: RoutingCompany[] = [];
  for (const c of companies) {
    // Departments from live postings, plus any that still carry an assignment
    // even though their posting was removed (so nothing dangles invisibly).
    const depts = await query<{ department: string }>(
      `SELECT DISTINCT department FROM (
         SELECT department FROM job_postings
           WHERE company_id = ? AND department IS NOT NULL AND TRIM(department) <> ''
         UNION
         SELECT department FROM department_assignments WHERE company_id = ?
       ) d ORDER BY department`,
      [c.company_id, c.company_id],
    );
    const recruiters = await query<{ user_id: number; full_name: string }>(
      `SELECT user_id, full_name FROM users
        WHERE role = 'recruiter' AND company_id = ? AND verified = 1
        ORDER BY full_name`,
      [c.company_id],
    );
    const assigns = await query<{ department: string; user_id: number; full_name: string }>(
      `SELECT da.department, da.user_id, u.full_name
         FROM department_assignments da JOIN users u ON u.user_id = da.user_id
        WHERE da.company_id = ?`,
      [c.company_id],
    );
    out.push({
      id: String(c.company_id),
      name: c.company_name,
      departments: depts.map((d) => d.department),
      recruiters: recruiters.map((r) => ({ id: String(r.user_id), name: r.full_name })),
      assignments: assigns.map((a) => ({ department: a.department, userId: String(a.user_id), userName: a.full_name })),
    });
  }
  return out;
}

router.post('/dept-assignments', async (req, res) => {
  const u = await requireRole(req, res, 'admin');
  if (!u) return;
  ok(res, { companies: await listDeptRouting() });
});

router.post('/assign-department', async (req, res) => {
  const u = await requireRole(req, res, 'admin');
  if (!u) return;
  const companyId = idOf(req.body?.companyId);
  const department = String(req.body?.department ?? '').trim();
  const rawUser = req.body?.userId;
  if (!companyId || !department) return fail(res, 'Pick a company and a department.');

  const company = await queryOne('SELECT 1 FROM companies WHERE company_id = ? LIMIT 1', [companyId]);
  if (!company) return fail(res, 'That company no longer exists.');

  // No user id (or an explicit "unassign") clears the owner — the department
  // falls back to notifying every verified recruiter.
  if (rawUser === null || rawUser === undefined || rawUser === '' || rawUser === 0 || rawUser === '0') {
    await exec('DELETE FROM department_assignments WHERE company_id = ? AND LOWER(TRIM(department)) = LOWER(?)', [companyId, department]);
    return ok(res, { companies: await listDeptRouting() });
  }

  const userId = Number(rawUser);
  const owner = await queryOne(
    "SELECT 1 FROM users WHERE user_id = ? AND role = 'recruiter' AND company_id = ? AND verified = 1 LIMIT 1",
    [userId, companyId],
  );
  if (!owner) return fail(res, 'Pick a verified recruiter from that company.');

  await exec(
    `INSERT INTO department_assignments (company_id, department, user_id)
       VALUES (?,?,?)
     ON CONFLICT (company_id, department)
       DO UPDATE SET user_id = EXCLUDED.user_id, assigned_at = now()`,
    [companyId, department, userId],
  );
  ok(res, { companies: await listDeptRouting() });
});

router.post('/recruiters', async (req, res) => {
  const u = await requireRole(req, res, 'admin');
  if (!u) return;
  const rows = await query<UserRow & { company_name: string | null }>(
    `SELECT u.*, c.company_name FROM users u
       LEFT JOIN companies c ON c.company_id = u.company_id
      WHERE u.role = 'recruiter' ORDER BY u.created_at DESC`,
  );
  ok(res, {
    recruiters: rows.map((r) => ({
      id: String(r.user_id),
      name: r.full_name,
      email: r.email,
      position: r.position_title || '',
      companyName: r.company_name || '—',
      verified: !!r.verified,
      createdAt: ts(r.created_at),
      lastLoginAt: r.last_login_at ? ts(r.last_login_at) : null,
    })),
  });
});

export default router;
