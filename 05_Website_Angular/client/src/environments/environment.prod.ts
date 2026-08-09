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
  /* The site's canonical origin, e.g. 'https://resumematch.ph'. Leave EMPTY
     and every canonical/Open Graph URL is taken from the browser's own
     location, which is correct on localhost, on a Netlify preview and on the
     final domain without anyone remembering to change it. Set it only to
     force one host to be canonical when the same build is served from
     several — and note that setting it wrong points every canonical tag at a
     site that is not this one. */
  siteUrl: '',
  /* Emit schema.org JobPosting structured data for each opening, which is
     what puts a listing into the Google Jobs box.

     OFF by default, deliberately. Google's JobPosting policy requires the
     listings to be real vacancies that come down when they are filled. The
     openings this build ships with are SEEDED DEMONSTRATION DATA for a
     capstone study, and publishing those as job postings would put jobs that
     do not exist in front of people in Angeles City who are actually looking
     for work. Turn this on only when the postings are real. */
  publishJobPostings: false,
};
