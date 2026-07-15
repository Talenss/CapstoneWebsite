import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';
import { Role } from './models';

/** Port of RMPH.guard(role) from assets/api.js. Not signed in → redirect to
 *  /auth?next=<path>. Wrong role → redirect to that role's own dashboard.
 *  Omit `role` to just require *any* signed-in user (account, resume-print). */
export function authGuard(role?: Role): CanActivateFn {
  return async (_route, state) => {
    const session = inject(SessionService);
    const router = inject(Router);

    const u = await session.refresh();
    if (!u) return router.createUrlTree(['/auth'], { queryParams: { next: state.url } });
    if (role && u.role !== role) return router.createUrlTree([session.homeFor(u)]);
    return true;
  };
}
