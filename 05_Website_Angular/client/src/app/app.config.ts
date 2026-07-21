import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';

import { routes } from './app.routes';
import { SessionService } from './core/session.service';

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
  ]
};
