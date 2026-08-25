import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/** The landing page, for somebody who already has an account.
 *
 *  Signed out, "/" is the marketing page and that is what it is for. Signed
 *  in, it is a page about signing up: it explains the site to someone who has
 *  already joined it, and puts the work they came back for behind another
 *  click. So a signed-in visitor is sent to their own dashboard instead —
 *  seeker, recruiter or admin, through the same homeFor() the log-in redirect
 *  and the header logo use, so all three can never disagree about where an
 *  account belongs.
 *
 *  This covers the ways in that the logo does not: a bookmark, typing the
 *  domain, following a shared link, or arriving back at the site in a tab
 *  that is still signed in.
 *
 *  ensure() rather than refresh(), because this runs on the most-visited
 *  route in the site and the session is already known after the first call.
 *  A guard that re-asked the server on every visit to "/" would add a round
 *  trip to the one page that should be instant. */
export const homeGuard: CanActivateFn = async () => {
  const session = inject(SessionService);
  const router = inject(Router);

  const u = await session.ensure();
  return u ? router.createUrlTree([session.homeFor(u)]) : true;
};
