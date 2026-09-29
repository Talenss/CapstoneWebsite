/* Linaw PH — routes/admin.ts
   The partner company's side of "recruiter accounts are provisioned, not
   self-served". The admin is the company's HEAD OF RECRUITMENT (see
   requireCompanyAdmin): they review the requests the auth page's
   recruiter form creates FOR THEIR COMPANY, and approving one is what
   actually creates the verified recruiter account. Admin accounts are made
   with `npm run create-admin`, which ties each to a company — there is
   deliberately no self-serve path. */
import { asyncRouter } from '../lib/async-router';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, queryOne, exec } from '../db';
import { UserRow } from '../types';
import { ok, fail, idOf } from '../lib/http';
import { requireCompanyAdmin, isCompanyAdmin, companyAdminCount } from '../lib/auth';
import { emailProblem } from '../lib/contact';
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

async function listRequests(companyId: number) {
  const rows = await query<RequestRow>(
    `SELECT r.*, c.company_name FROM recruiter_requests r
       LEFT JOIN companies c ON c.company_id = r.company_id
      WHERE r.company_id = ?
      ORDER BY (r.status = 'pending') DESC, r.requested_at DESC`, [companyId],
  );
  return rows.map(serializeRequest);
}

router.post('/requests', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  ok(res, { requests: await listRequests(u.company_id!) });
});

/* Approving a request IS the account creation. The account gets an
   unguessable placeholder password; the approval email tells the person
   to use "Forgot password" to set their own — same proven code flow,
   nothing new to secure. */
router.post('/approve', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const id = idOf(req.body?.id);

  const r = await queryOne<RequestRow>(
    `SELECT r.*, c.company_name FROM recruiter_requests r
       LEFT JOIN companies c ON c.company_id = r.company_id
      WHERE r.request_id = ? LIMIT 1`, [id],
  );
  // Another company's request reads as "not found", not "forbidden": a head
  // of recruitment has no business learning that it exists.
  if (!r || r.company_id !== u.company_id) return fail(res, 'Request not found.');
  if (r.status !== 'pending') return fail(res, 'This request was already handled.');

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
      'Your Linaw PH recruiter access is approved',
      `Welcome aboard\n\nYour recruiter account for ${co} is active.\n\nTo set your password: open ${APP_URL}/auth, click "Forgot your password?", enter this email address, and follow the code we send you. After that you can log in and manage your postings.`,
      `
        <h1 style="margin:0 0 10px;font-size:22px">Welcome aboard</h1>
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:#4C5566">Hi ${r.full_name},</p>
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:#4C5566">Your recruiter account for <b>${co}</b> on Linaw PH is now active — confirmed by your company’s head of recruitment.</p>
        <p style="margin:0;font-size:14.5px;line-height:1.65;color:#4C5566"><b>One step left — set your password:</b> open the site, choose <b>“Forgot your password?”</b> on the log-in panel, enter this email address, and follow the code we send you. Then log in and your postings are yours to manage.</p>
        <p style="margin:22px 0 0"><a href="${APP_URL}/auth" style="display:inline-block;background:#C9A24B;color:#141926;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:8px">Set my password</a></p>`,
    ).catch((e) => console.error('approval email failed:', e?.message || e));
  } else if (DEBUG) {
    console.log(`[admin] approved ${r.email} — SMTP not configured, tell them to use "Forgot password" to set a password.`);
  }

  ok(res, { requests: await listRequests(u.company_id!) });
});

router.post('/decline', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const id = idOf(req.body?.id);

  const r = await queryOne<RequestRow>('SELECT * FROM recruiter_requests WHERE request_id = ? LIMIT 1', [id]);
  if (!r || r.company_id !== u.company_id) return fail(res, 'Request not found.');
  if (r.status !== 'pending') return fail(res, 'This request was already handled.');

  await exec("UPDATE recruiter_requests SET status = 'declined' WHERE request_id = ?", [id]);

  if (mailConfigured()) {
    sendMail(
      r.email,
      'About your Linaw PH recruiter request',
      `We couldn't verify this request\n\nYour request for recruiter access wasn't approved this time. This usually means your company's head of recruitment couldn't confirm that you work there. If you believe this is a mistake, please contact your head of recruitment directly.`,
      `
        <h1 style="margin:0 0 10px;font-size:22px">We couldn’t verify this request</h1>
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:#4C5566">Hi ${r.full_name},</p>
        <p style="margin:0;font-size:14.5px;line-height:1.65;color:#4C5566">Your request for recruiter access wasn’t approved this time. This usually means your company’s head of recruitment couldn’t confirm that you work there. If you believe this is a mistake, please contact your head of recruitment directly.</p>`,
    ).catch((e) => console.error('decline email failed:', e?.message || e));
  } else if (DEBUG) {
    console.log(`[admin] declined request from ${r.email}`);
  }

  ok(res, { requests: await listRequests(u.company_id!) });
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

async function listDeptRouting(companyId: number): Promise<RoutingCompany[]> {
  // The head's own company, when it has postings (so there are departments
  // to route).
  const companies = await query<{ company_id: number; company_name: string }>(
    `SELECT DISTINCT c.company_id, c.company_name
       FROM companies c JOIN job_postings jp ON jp.company_id = c.company_id
      WHERE c.company_id = ?
      ORDER BY c.company_name`, [companyId],
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
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  ok(res, { companies: await listDeptRouting(u.company_id!) });
});

router.post('/assign-department', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const companyId = idOf(req.body?.companyId);
  const department = String(req.body?.department ?? '').trim();
  const rawUser = req.body?.userId;
  if (!companyId || !department) return fail(res, 'Pick a company and a department.');
  if (companyId !== u.company_id) return fail(res, "You can only route your own company's departments.", 403);

  const company = await queryOne('SELECT 1 FROM companies WHERE company_id = ? LIMIT 1', [companyId]);
  if (!company) return fail(res, 'That company no longer exists.');

  // No user id (or an explicit "unassign") clears the owner — the department
  // falls back to notifying every verified recruiter.
  if (rawUser === null || rawUser === undefined || rawUser === '' || rawUser === 0 || rawUser === '0') {
    await exec('DELETE FROM department_assignments WHERE company_id = ? AND LOWER(TRIM(department)) = LOWER(?)', [companyId, department]);
    return ok(res, { companies: await listDeptRouting(u.company_id!) });
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
  ok(res, { companies: await listDeptRouting(u.company_id!) });
});

router.post('/recruiters', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const rows = await query<UserRow & { company_name: string | null }>(
    `SELECT u.*, c.company_name FROM users u
       LEFT JOIN companies c ON c.company_id = u.company_id
      WHERE u.role = 'recruiter' AND u.company_id = ? ORDER BY u.created_at DESC`, [u.company_id],
  );
  ok(res, {
    recruiters: rows.map((r) => ({
      id: String(r.user_id),
      name: r.full_name,
      email: r.email,
      position: r.position_title || '',
      companyName: r.company_name || '—',
      verified: !!r.verified,
      isAdmin: isCompanyAdmin(r),
      createdAt: ts(r.created_at),
      lastLoginAt: r.last_login_at ? ts(r.last_login_at) : null,
    })),
  });
});

/* ---------- who can use this panel ----------
   The expert review: the admin panel should be available to "the main
   recruiter / IT manager". So it is no longer one fixed account. Any admin
   can give admin access to a verified recruiter at the company (who keeps
   recruiting), add an admin-only account for someone who does not recruit
   (an IT manager), and take either away again. The one thing refused is
   leaving the company with no admin at all. */

async function listAdmins(companyId: number, meId: number) {
  const rows = await query<UserRow>(
    `SELECT * FROM users
      WHERE company_id = ? AND (role = 'admin' OR (role = 'recruiter' AND is_admin AND verified = 1))
      ORDER BY (role = 'admin') DESC, full_name`, [companyId],
  );
  return rows.map((r) => ({
    id: String(r.user_id),
    name: r.full_name,
    email: r.email,
    position: r.position_title || '',
    kind: r.role === 'admin' ? 'admin' as const : 'recruiter' as const,
    isYou: r.user_id === meId,
    lastLoginAt: r.last_login_at ? ts(r.last_login_at) : null,
  }));
}

router.post('/admins', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  ok(res, { admins: await listAdmins(u.company_id!, u.user_id) });
});

router.post('/grant-admin', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const id = idOf(req.body?.userId);
  const t = await queryOne<UserRow>('SELECT * FROM users WHERE user_id = ? LIMIT 1', [id]);
  // Someone at another company reads as not found, as everywhere here.
  if (!t || t.company_id !== u.company_id || t.role !== 'recruiter') return fail(res, 'Recruiter not found.');
  if (!t.verified) return fail(res, 'Only a verified recruiter can be given admin access.');
  if (t.is_admin) return fail(res, `${t.full_name} already has admin access.`);
  await exec('UPDATE users SET is_admin = true WHERE user_id = ?', [t.user_id]);
  ok(res, { admins: await listAdmins(u.company_id!, u.user_id) });
});

/* Taking access away. From a recruiter it removes the panel and leaves them
   recruiting; an admin-only account has nothing else to fall back to, so it
   is removed outright (its approvals and routing history keep their rows,
   with the name cleared, as they do when anyone deletes their account). */
router.post('/revoke-admin', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const id = idOf(req.body?.userId);
  const t = await queryOne<UserRow>('SELECT * FROM users WHERE user_id = ? LIMIT 1', [id]);
  if (!t || t.company_id !== u.company_id || !isCompanyAdmin(t)) return fail(res, 'Admin not found.');
  if ((await companyAdminCount(u.company_id!)) <= 1)
    return fail(res, 'This is the only admin for your company. Give someone else admin access first, so the company is never left without one.');
  if (t.role === 'admin') await exec('DELETE FROM users WHERE user_id = ?', [t.user_id]);
  else await exec('UPDATE users SET is_admin = false WHERE user_id = ?', [t.user_id]);
  ok(res, { admins: await listAdmins(u.company_id!, u.user_id), removedSelf: t.user_id === u.user_id });
});

/* An admin-only account, for someone who looks after the system but does
   not recruit. Created the way an approved recruiter is: verified, with an
   unguessable placeholder password, and the person sets their own through
   "Forgot password". Nobody ever types a password for someone else. */
router.post('/add-admin', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const first = String(req.body?.firstName ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const last = String(req.body?.lastName ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const position = String(req.body?.position ?? '').trim().replace(/\s+/g, ' ').slice(0, 120) || 'IT Manager';
  if (!first || !last) return fail(res, 'Enter their first and last name.');
  const eErr = emailProblem(email);
  if (!email || eErr) return fail(res, eErr || 'Enter their work email address.');
  if (await queryOne('SELECT 1 FROM users WHERE LOWER(email) = ? LIMIT 1', [email]))
    return fail(res, 'An account already uses this email. If they are a recruiter here, give them admin access from the recruiter list instead.');

  const placeholder = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  await exec(
    `INSERT INTO users (role, first_name, last_name, email, password_hash, company_id, position_title, verified)
     VALUES ('admin', ?, ?, ?, ?, ?, ?, 1)`,
    [first, last, email, placeholder, u.company_id, position],
  );

  const co = await queryOne<{ company_name: string }>('SELECT company_name FROM companies WHERE company_id = ?', [u.company_id]);
  if (mailConfigured()) {
    sendMail(
      email,
      'You have admin access to Linaw PH',
      `You have been given admin access to Linaw PH for ${co?.company_name ?? 'your company'} by ${u.full_name}.\n\nTo set your password: open ${APP_URL}/auth, click "Forgot your password?", enter this email address, and follow the code we send you.`,
      `
        <h1 style="margin:0 0 10px;font-size:22px">You have admin access</h1>
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:#4C5566">Hi ${first},</p>
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:#4C5566">${u.full_name} has given you admin access to Linaw PH for <b>${co?.company_name ?? 'your company'}</b>, as ${position}.</p>
        <p style="margin:0;font-size:14.5px;line-height:1.65;color:#4C5566"><b>Set your password:</b> open the site, choose <b>“Forgot your password?”</b> on the log-in panel, enter this email address, and follow the code we send you.</p>`,
    ).catch((e) => console.error('admin invite email failed:', e?.message || e));
  } else if (DEBUG) {
    console.log(`[admin] added admin ${email} — SMTP not configured, tell them to use "Forgot password".`);
  }
  ok(res, { admins: await listAdmins(u.company_id!, u.user_id) });
});

export default router;
