/* Linaw PH — lib/rate-limit.ts
   Brute-force protection for the auth surface. The email-code table
   already rate-limits per address; these limiters add the per-client
   layer underneath (fixed windows, in-memory — right-sized for a
   single-process pilot deployment).

   NOTE: behind a reverse proxy every client shares the proxy's IP until
   TRUST_PROXY=true is set in .env — see SETUP.md. */
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { Request, Response } from 'express';

const tooMany = (what: string) => (_req: Request, res: Response) =>
  res.status(429).json({ ok: false, error: `Too many ${what}. Wait a few minutes and try again.` });

/** Login: 10 FAILED tries per 15 minutes per client+email pair —
 *  successful logins never count against the limit. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip || '')}|${String(req.body?.email || '').trim().toLowerCase()}`,
  handler: tooMany('login attempts'),
  standardHeaders: true,
  legacyHeaders: false,
});

/** Code emails (verify + reset): 8 sends per 15 minutes per client, on
 *  top of the per-address cooldown and hourly cap in email-codes.ts. */
export const sendCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  handler: tooMany('code requests'),
  standardHeaders: true,
  legacyHeaders: false,
});

/** Account creation & password reset submissions: 20 per 15 minutes per
 *  client — roomy for humans, tight for scripts guessing codes. */
export const authWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  handler: tooMany('attempts'),
  standardHeaders: true,
  legacyHeaders: false,
});
