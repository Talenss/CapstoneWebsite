/* ResumeMatch PH — lib/async-router.ts

   Express 4 does not understand async handlers. If one rejects — a failed
   query, a constraint violation, a dropped connection — the rejection is
   never passed to the error middleware. Node then treats it as an unhandled
   rejection and TERMINATES THE PROCESS, mid-request, without answering the
   caller. A single request for a posting id that does not exist was enough
   to take the whole API down.

   asyncRouter() returns an ordinary express.Router whose route methods wrap
   every handler so a rejected promise is forwarded to next(). The error
   middleware in server.ts then answers with a normal JSON error and the
   process stays up. Routers use it in place of Router().

   Express 5 does this natively; when the project upgrades, this file and the
   `asyncRouter()` calls can be replaced by plain `Router()` again. */
import { Router, RequestHandler, IRouter } from 'express';

/** Route-registering methods we wrap. `use` and `param` are left alone —
 *  they take middleware whose contract already includes next(). */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;

function wrap(handler: RequestHandler): RequestHandler {
  // Error-handling middleware has arity 4 and must not be wrapped.
  if (handler.length >= 4) return handler;
  const wrapped: RequestHandler = function (this: unknown, req, res, next) {
    try {
      const out: unknown = (handler as (...a: unknown[]) => unknown)
        .call(this, req, res, next);
      // Only promises need catching; sync handlers return undefined.
      if (out && typeof (out as Promise<unknown>).catch === 'function') {
        (out as Promise<unknown>).catch(next);
      }
    } catch (err) {
      // A synchronous throw before the first await.
      next(err);
    }
  };
  return wrapped;
}

export function asyncRouter(): IRouter {
  const router = Router();
  for (const m of METHODS) {
    const original = (router as any)[m].bind(router);
    (router as any)[m] = (path: any, ...handlers: any[]) =>
      original(path, ...handlers.map((h: any) => (typeof h === 'function' ? wrap(h) : h)));
  }
  return router;
}
