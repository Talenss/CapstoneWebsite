// PRODUCTION build. angular.json swaps environment.ts for this file, so this
// is what `npm run build` actually ships — and what server.ts serves out of
// client/dist. It must be 'api': a production bundle left in demo mode keeps
// every visitor's data in their own browser and never calls the API at all,
// which silently bypasses authentication, ownership checks and persistence.
//
// To build a browser-only bundle on purpose (a kiosk demo, or a static host
// with no server), use the demo configuration, which skips this replacement:
//   npm run build:demo
export const environment = {
  production: true,
  mode: 'api' as 'demo' | 'api',
  apiBase: '/api',
};
