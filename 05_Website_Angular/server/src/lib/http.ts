import { Response } from 'express';

export function ok(res: Response, data: Record<string, any> = {}) {
  res.json({ ok: true, ...data });
}

export function fail(res: Response, message: string, code = 200) {
  res.status(code).json({ ok: false, error: message });
}

/** Coerce a request field into a usable row id.
 *
 *  Anything that is not a positive whole number becomes 0. That matters:
 *  `Number(undefined)` is NaN, and handing NaN to pg as an integer parameter
 *  throws inside the handler — which surfaced to the caller as "the service
 *  is unavailable" for what is really just a malformed request, and before
 *  async-router existed took the whole process down.
 *
 *  0 is deliberate rather than null: every route already guards with
 *  `if (!id) return fail(...)`, and any query that does reach the database
 *  with 0 simply matches no row, so the route's own "not found" path runs. */
export function idOf(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
