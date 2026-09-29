import { Request, Response } from 'express';
import { queryOne } from '../db';
import { UserRow } from '../types';
import { fail } from './http';

export async function currentUser(req: Request): Promise<UserRow | null> {
  const uid = req.session.uid;
  if (!uid) return null;
  return queryOne<UserRow>('SELECT * FROM users WHERE user_id = ? LIMIT 1', [uid]);
}

/** Returns the user, or sends a 401 and returns null. Callers must
 *  `if (!u) return;` immediately after calling this. */
export async function requireUser(req: Request, res: Response): Promise<UserRow | null> {
  const u = await currentUser(req);
  if (!u) {
    fail(res, 'You are not signed in.', 401);
    return null;
  }
  return u;
}

/** Returns the user if they hold `role`, or sends a 401/403 and returns null. */
export async function requireRole(req: Request, res: Response, role: 'seeker' | 'recruiter' | 'admin'): Promise<UserRow | null> {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.role !== role) {
    fail(res, "You don't have access to that.", 403);
    return null;
  }
  return u;
}

/** Whether this account may use its company's admin panel.
 *
 *  Two kinds of person, after the expert review asked for the panel to be
 *  available to "the main recruiter / IT manager":
 *    · an ADMIN-ONLY account (role 'admin'), such as an IT manager, or the
 *      head of recruitment set up with `npm run create-admin`
 *    · a RECRUITER GIVEN ADMIN ACCESS (is_admin), who keeps their recruiter
 *      dashboard and has the panel as well
 *  Either way the account must belong to a company, and a recruiter must be
 *  verified. */
export function isCompanyAdmin(u: UserRow | null | undefined): boolean {
  if (!u || !u.company_id) return false;
  if (u.role === 'admin') return true;
  return u.role === 'recruiter' && !!u.is_admin && !!u.verified;
}

/** How many people can use this company's admin panel. The panel refuses
 *  anything that would take this to zero, so a company can never lock itself
 *  out of approving its own recruiters. */
export async function companyAdminCount(companyId: number): Promise<number> {
  const r = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users
      WHERE company_id = ? AND (role = 'admin' OR (role = 'recruiter' AND is_admin AND verified = 1))`,
    [companyId],
  );
  return Number(r?.n ?? 0);
}

/** THE ADMIN LEVEL BELONGS TO A PARTNER COMPANY'S OWN PEOPLE, and covers
 *  that company only.
 *
 *  It was the research team's, with every company in view — which answers
 *  nothing once the study ends and the researchers leave. The person who can
 *  actually confirm that a recruiter works at the company is the company's
 *  own head of recruitment, so they approve their recruiters, route their
 *  departments, and see nobody else's.
 *
 *  An admin account with no company is the old research-team account. It
 *  can still sign in, but every admin route refuses it with a message that
 *  says how to set up the head of recruitment instead. */
export async function requireCompanyAdmin(req: Request, res: Response): Promise<UserRow | null> {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.role !== 'admin' && !isCompanyAdmin(u)) {
    fail(res, "You don't have access to that.", 403);
    return null;
  }
  if (!u.company_id) {
    fail(res, "This admin account isn't linked to a partner company. The admin level belongs to the company's head of recruitment; set one up with: npm run create-admin -- <email> <password> \"<company name>\"", 403);
    return null;
  }
  return u;
}
