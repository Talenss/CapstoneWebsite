import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
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

  variant = input<'guest' | 'seeker' | 'recruiter' | 'admin' | 'auth'>('guest');
  active = input<string>('');
  showTour = input(false);

  menuOpen = false;

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
    this.tour.start(true);
  }

  async logout(): Promise<void> {
    await this.session.logout();
    location.href = '/';
  }
}
