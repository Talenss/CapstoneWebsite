/* Linaw PH — core/demo-adapter.stub.ts

   PRODUCTION STAND-IN for demo-adapter.ts. angular.json swaps the real
   file for this one in the `production` configuration, exactly as it
   swaps environment.ts for environment.prod.ts.

   WHY. The real demo adapter carries the seeded demonstration dataset —
   sample accounts, their email addresses, and the shared demo password.
   Both adapters are imported statically by api.service.ts, so without
   this replacement all of that is compiled into the api-mode bundle and
   readable by anyone who opens the deployed site's JavaScript. It is
   never executed there, because ApiService selects HttpAdapter whenever
   environment.mode is 'api' — but shipping sample credentials to a live
   site invites someone to try them, and the answer to "are those real?"
   should be that they are not present at all.

   The demo build (`npm run build:demo`) applies no replacement and gets
   the real adapter, which is the whole point of that build.

   The throw is unreachable by construction. If it ever fires, an api
   -mode bundle has tried to run in demo mode, which means the build was
   configured wrong — and failing loudly is better than silently keeping
   a live visitor's data in their own browser. */
import type { ApiAdapter } from './adapter';

export const DemoAdapter = function DemoAdapter(): ApiAdapter {
  throw new Error(
    'DemoAdapter is not available in an api-mode build. ' +
    'Build with `npm run build:demo` for the browser-only demonstration.',
  );
} as unknown as { new (): ApiAdapter };
