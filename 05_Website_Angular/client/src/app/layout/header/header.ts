import { Component, computed, inject, input } from '@angular/core';
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
 *  repeated across every page in 04_Website/app/*.html, plus the mobile
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

  variant = input<'guest' | 'seeker' | 'recruiter' | 'admin' | 'auth'>('guest');
  active = input<string>('');
  showTour = input(false);

  menuOpen = false;

  constructor() {
    // Close the mobile menu whenever a navigation completes, so tapping a
    // link never leaves the open menu covering the page.
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => (this.menuOpen = false));
  }

  brandSuffix = computed(() =>
    this.variant() === 'recruiter' ? 'Recruiter' : this.variant() === 'admin' ? 'Research Team' : 'Philippines');

  navItems = computed<NavItem[]>(() => {
    switch (this.variant()) {
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
          { key: 'account', label: 'Account', link: '/account' },
        ];
      case 'admin':
        return [
          { key: 'admin', label: 'Recruiter requests', link: '/admin' },
          { key: 'metrics', label: 'Study metrics', link: '/admin/metrics' },
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
