import { Response } from 'express';

export function ok(res: Response, data: Record<string, any> = {}) {
  res.json({ ok: true, ...data });
}

export function fail(res: Response, message: string, code = 200) {
  res.status(code).json({ ok: false, error: message });
}
