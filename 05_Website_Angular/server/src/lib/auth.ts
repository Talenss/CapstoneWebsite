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
export async function requireRole(req: Request, res: Response, role: 'seeker' | 'recruiter'): Promise<UserRow | null> {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.role !== role) {
    fail(res, "You don't have access to that.", 403);
    return null;
  }
  return u;
}
