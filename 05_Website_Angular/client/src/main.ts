import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Apply the saved (or OS-preferred) light/dark theme before Angular renders,
// so there's no flash of the wrong theme. Runs from the bundled main.js, so
// it satisfies the server's script-src 'self' CSP (an inline <script> would
// be blocked). The header's toggle keeps localStorage + the attribute in sync.
(() => {
  try {
    let t = localStorage.getItem('rmph-theme');
    if (t !== 'dark' && t !== 'light') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch { /* private mode — default light */ }
})();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
