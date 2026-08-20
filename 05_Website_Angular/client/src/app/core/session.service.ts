import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { User } from './models';

/** Holds the signed-in user for the lifetime of the app. Route guards
 *  populate it before a protected page activates, so page components can
 *  read session.user() synchronously, mirroring the original
 *  `const user = await RMPH.guard('seeker')` pattern. */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private api = inject(ApiService);
  readonly user = signal<User | null>(null);
  private loaded = false;

  async refresh(): Promise<User | null> {
    const res = await this.api.auth.me();
    const u = res.ok ? res.user : null;
    this.user.set(u);
    this.loaded = true;
    return u;
  }

  /** Returns the cached user, fetching once if this is the first call. */
  async ensure(): Promise<User | null> {
    if (this.loaded) return this.user();
    return this.refresh();
  }

  async logout(): Promise<void> {
    await this.api.auth.logout();
    this.user.set(null);
  }

  homeFor(u: User | null): string {
    if (!u) return '/';
    return u.role === 'seeker' ? '/seeker-dashboard' : u.role === 'admin' ? '/admin' : '/hr-dashboard';
  }
}
