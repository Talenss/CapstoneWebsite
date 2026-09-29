import { Component, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { SessionService } from '../../core/session.service';
import { TourService } from '../../shared/tour/tour.service';

export interface NavItem {
  key: string;
  label: string;
  link: string;
}

/** Shared site header ("the front desk"). Port of the <header> markup
 *  repeated across every page of the PHP version, plus the mobile
 *  menu / identity / logout wiring from assets/api.js's DOMContentLoaded
 *  handler. `variant` picks the nav-link set; `active` highlights one. */
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './header.html',
  styleUrl: './header.css',
})
export class Header {
  session = inject(SessionService);
  private tour = inject(TourService);
  private router = inject(Router);

  variant = input<'guest' | 'seeker' | 'recruiter' | 'admin' | 'auth' | 'auto'>('guest');
  active = input<string>('');
  showTour = input(false);

  menuOpen = false;

  /** The skip link, done properly.
   *
   *  It cannot be a plain href="#main": index.html sets <base href="/">, and
   *  a bare fragment resolves against the BASE rather than the current page,
   *  so on /privacy the browser went to /#main, the home page. Verified on
   *  /learning-hub, /privacy and /browse; every one navigated away.
   *
   *  Scrolling alone would not be enough either. The point of a skip link is
   *  to move the KEYBOARD CARET past the navigation, so the next Tab lands
   *  inside the content. Angular's anchorScrolling only scrolls, focus would
   *  stay in the header and the next Tab would walk back through the nav,
   *  which is exactly what the link exists to avoid. So this moves focus and
   *  lets that scroll the element into view.
   *
   *  tabindex="-1" makes <main> focusable programmatically without adding it
   *  to the tab order. preventScroll + scrollIntoView keeps the movement
   *  smooth rather than jumping. */
  skipToMain(e: Event): void {
    const main = document.getElementById('main');
    if (!main) return;          // no target: let the browser do whatever it would
    e.preventDefault();
    main.setAttribute('tabindex', '-1');
    main.focus({ preventScroll: true });
    main.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Light/dark theme. The no-flash init script in index.html sets the
   *  data-theme attribute before Angular boots; this just mirrors and
   *  toggles it. */
  theme = signal<'light' | 'dark'>(
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  );

  toggleTheme(): void {
    const next = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('linaw-theme', next); } catch { /* private mode */ }
  }

  /** The variant actually used for the nav. `auto` lets a shared/public page
   *  (home, learning hub, privacy, 404) inherit the signed-in user's own nav
   *  instead of collapsing to the two guest links, so a seeker who opens the
   *  learning hub keeps their Dashboard / My resumes / Builder links. Any
   *  explicit variant (including 'guest' and 'auth') passes straight through. */
  effectiveVariant = computed(() => {
    const v = this.variant();
    if (v !== 'auto') return v;
    const role = this.session.user()?.role;
    return role === 'seeker' ? 'seeker' : role === 'admin' ? 'admin' : role === 'recruiter' ? 'recruiter' : 'guest';
  });

  constructor() {
    // Close the mobile menu whenever a navigation completes, so tapping a
    // link never leaves the open menu covering the page.
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => (this.menuOpen = false));
  }

  /** Where the logo goes.
   *
   *  Signed out it is the marketing home page, which is what a logo is for.
   *  Signed in it is that account's own dashboard, because for someone with
   *  an account the home page is a page about signing up — it has nothing on
   *  it they have not already done, and it hides the work they came back for
   *  behind another click. The signed-in header carries no other route back
   *  to the dashboard on a phone, where the nav collapses into the menu, so
   *  the logo is the only always-visible way home.
   *
   *  This is the convention every application with a signed-in state uses:
   *  the logo means "take me to the top of MY view of this site", and which
   *  page that is depends on who is looking. Each role gets its own, via the
   *  same homeFor() the log-in redirect uses, so the logo and the log-in can
   *  never disagree about where an account belongs. */
  brandHome = computed(() => this.session.homeFor(this.session.user()));

  brandSuffix = computed(() =>
    this.effectiveVariant() === 'recruiter' ? 'Recruiter' : this.effectiveVariant() === 'admin' ? 'Admin' : 'Philippines');

  navItems = computed<NavItem[]>(() => {
    switch (this.effectiveVariant()) {
      case 'seeker':
        return [
          { key: 'dashboard', label: 'Dashboard', link: '/seeker-dashboard' },
          { key: 'openings', label: 'Openings', link: '/browse' },
          { key: 'my-resumes', label: 'My resumes', link: '/my-resumes' },
          { key: 'builder', label: 'Builder', link: '/resume-builder' },
          { key: 'learning-hub', label: 'Learning hub', link: '/learning-hub' },
          { key: 'account', label: 'Account', link: '/account' },
        ];
      case 'recruiter':
        return [
          { key: 'dashboard', label: 'Dashboard', link: '/hr-dashboard' },
          { key: 'post', label: 'Post an opening', link: '/hr-posting' },
          { key: 'company', label: 'Company profile', link: '/hr-company' },
          // A recruiter given admin access reaches the panel from here.
          ...(this.session.user()?.isAdmin ? [{ key: 'admin', label: 'Admin panel', link: '/admin' }] : []),
          { key: 'account', label: 'Account', link: '/account' },
        ];
      case 'admin':
        return [
          // ...and gets their own dashboard back from the admin side.
          ...(this.session.user()?.role === 'recruiter' ? [{ key: 'dashboard', label: 'Recruiter dashboard', link: '/hr-dashboard' }] : []),
          { key: 'admin', label: 'Admin panel', link: '/admin' },
          { key: 'skills', label: 'Skill dictionary', link: '/admin/skills' },
          { key: 'metrics', label: 'Platform metrics', link: '/admin/metrics' },
          { key: 'account', label: 'Account', link: '/account' },
        ];
      default:
        return [
          { key: 'openings', label: 'Openings', link: '/browse' },
          { key: 'learning-hub', label: 'Learning hub', link: '/learning-hub' },
        ];
    }
  });

  toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
  }

  replayTour(): void {
    // Close the mobile menu first so it doesn't sit on top of the tour,
    // then start on the next tick once the menu has actually collapsed.
    this.menuOpen = false;
    setTimeout(() => this.tour.start(true), 50);
  }

  async logout(): Promise<void> {
    await this.session.logout();
    location.href = '/';
  }
}
