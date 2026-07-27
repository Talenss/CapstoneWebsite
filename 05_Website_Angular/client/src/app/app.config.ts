import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';

import { routes } from './app.routes';
import { SessionService } from './core/session.service';
import { environment } from '../environments/environment';
import { applyMatchSettings } from './core/engine';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    // Load the signed-in user once at startup so session.user() is populated
    // on every page — including public routes with no guard (home, privacy,
    // 404). Fire-and-forget: the app paints immediately and the header's
    // `auto` variant upgrades to the user's own nav when /me resolves.
    provideAppInitializer(() => { void inject(SessionService).ensure(); }),
    // Adopt the server's scoring weights so the live score shown while
    // browsing equals the score the server computes and stores on apply.
    // Demo mode has no server, so it keeps the published defaults.
    // Fire-and-forget, and failure is silent: an unreachable settings
    // endpoint must not stop the app from painting.
    provideAppInitializer(() => {
      if (environment.mode !== 'api') return;
      void fetch(`${environment.apiBase}/match/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: '{}',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j?.ok) applyMatchSettings(j); })
        .catch(() => { /* keep the published defaults */ });
    }),
  ]
};
