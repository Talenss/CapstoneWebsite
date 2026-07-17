// The ONE switch: 'demo' runs entirely in the browser (localStorage), zero
// setup, matching the original PHP app's default. 'api' talks to the Node
// backend at apiBase (proxied to the Express server in dev — see proxy.conf.json).
export const environment = {
  production: false,
  mode: 'demo' as 'demo' | 'api',
  apiBase: '/api',
};
