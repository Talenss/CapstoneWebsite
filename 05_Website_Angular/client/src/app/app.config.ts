import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';

import { routes } from './app.routes';
import { SessionService } from './core/session.service';
import { environment } from '../environments/environment';
import { applyMatchSettings, applyDictionary } from './core/engine';
import { ApiService } from './core/api.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    /* anchorScrolling makes a URL fragment actually scroll to its element,
       which is what the learning hub's guide links rely on. Those links go
       through the router (routerLink + fragment) rather than a bare
       href="#id", because index.html sets <base href="/"> and a browser
       resolves a bare fragment against the base, sending the reader to the
       home page instead of the guide.

       scrollPositionRestoration is deliberately left at its default of
       'disabled': turning it on would change how EVERY navigation in the app
       restores scroll, which is a much larger behavioural change than the
       one bug being fixed here. */
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ anchorScrolling: 'enabled' }),
    ),
    provideHttpClient(withFetch()),
    // Load the signed-in user once at startup so session.user() is populated
    // on every page, including public routes with no guard (home, privacy,
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
    // The skill dictionary the admins keep: the catalogue the pickers offer,
    // and the synonyms they have linked, so this browser's engine (live
    // previews, the job board) matches skills exactly as the server does.
    // Same terms as the settings above: fire-and-forget, and on failure the
    // shipped catalogue and built-in synonyms stay in place.
    provideAppInitializer(() => {
      void inject(ApiService).skills.dictionary()
        .then((r) => { if (r.ok) applyDictionary(r); })
        .catch(() => { /* keep the shipped dictionary */ });
    }),
  ]
};
