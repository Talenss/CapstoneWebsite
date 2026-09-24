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

/** THE ADMIN LEVEL BELONGS TO A PARTNER COMPANY'S HEAD OF RECRUITMENT, and
 *  covers that company only.
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
export async function requireHeadOfRecruitment(req: Request, res: Response): Promise<UserRow | null> {
  const u = await requireRole(req, res, 'admin');
  if (!u) return null;
  if (!u.company_id) {
    fail(res, "This admin account isn't linked to a partner company. The admin level belongs to the company's head of recruitment; set one up with: npm run create-admin -- <email> <password> \"<company name>\"", 403);
    return null;
  }
  return u;
}
