import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router, RouterOutlet,
} from '@angular/router';

/** Each page owns its own <app-header>/<app-footer> (variants differ too
 *  much across guest/seeker/recruiter/auth/print to share one app shell),
 *  so the root component is the router outlet plus the one thing that has
 *  to sit above every page: a sign that a route is loading.
 *
 *  All eighteen routes are loadComponent — fetched lazily — so between the
 *  click and the chunk arriving there is nothing rendered at all. That
 *  showed as a blank page for a second or so with no indication the click
 *  had registered, which is the moment people click again, hit refresh, or
 *  give up on the flow.
 *
 *  A bar rather than the .spinner the pages already use for data loading:
 *  those sit inside a page that exists, whereas this appears when there is
 *  no page yet. Pinned to the top edge, it occupies none of the space the
 *  incoming page is about to fill, so nothing jumps when the chunk lands. */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private router = inject(Router);

  navigating = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((e) => {
      if (e instanceof NavigationStart) {
        /* Held back briefly on purpose. An already-cached chunk arrives in a
           few milliseconds, and a bar that appears and vanishes that fast
           reads as a glitch — worse than no bar at all. Only a navigation
           slow enough to be noticed gets an indicator. */
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.navigating.set(true), 150);
        return;
      }
      /* Cancel and Error matter as much as End: a guard that redirects, or a
         chunk that fails to download, must not leave the bar running for the
         rest of the session. */
      if (e instanceof NavigationEnd || e instanceof NavigationCancel || e instanceof NavigationError) {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.navigating.set(false);
      }
    });
  }
}
