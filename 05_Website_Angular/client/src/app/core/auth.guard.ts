import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';
import { Role } from './models';

/** Port of LINAW.guard(role) from assets/api.js. Not signed in → redirect to
 *  /auth?next=<path>. Wrong role → redirect to that role's own dashboard.
 *  Omit `role` to just require *any* signed-in user (account, resume-print). */
export function authGuard(role?: Role): CanActivateFn {
  return async (_route, state) => {
    const session = inject(SessionService);
    const router = inject(Router);

    const u = await session.refresh();
    if (!u) return router.createUrlTree(['/auth'], { queryParams: { next: state.url } });
    // The admin pages also admit a recruiter who has been given admin access;
    // they stay a recruiter everywhere else.
    const allowed = !role || u.role === role || (role === 'admin' && !!u.isAdmin);
    if (!allowed) return router.createUrlTree([session.homeFor(u)]);
    return true;
  };
}
