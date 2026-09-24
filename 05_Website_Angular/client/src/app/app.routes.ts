/* ============================================================
   Routes, and what each page tells a search engine about itself.

   The `title` is the search result's headline and the `seo.description`
   the text under it. Both are per route on purpose: one shared
   description in index.html would describe eighteen different pages
   identically, which reads to a crawler as eighteen copies of the same
   page.

   The four public pages lead with what someone would actually type, "resume builder", "ATS", "Angeles City", "Clark", rather than with
   the site's name, because nobody searches for a site they have not
   heard of. The brand goes last, where it is still visible in the tab.

   Everything behind a login is `index: false`. Note what actually
   happens to a crawler there, which is not what that flag suggests:
   the auth guard redirects it to /auth before the page loads, so it
   reads /auth's title and description with a canonical pointing at
   /auth, verified in a browser. The flag applies in the other case,
   when a signed-in person is on the page, and robots.txt keeps the
   crawler off those paths in the first place.
   ============================================================ */
import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { homeGuard } from './core/home.guard';
import { unsavedChangesGuard } from './core/unsaved-changes.guard';
import { SeoData } from './core/seo';

/** Shorthand so a route reads as `...seo({ description: '…' })`. */
const seo = (data: SeoData) => ({ seo: data });

/** Every private page says the same thing to a crawler, so it is said once. */
const PRIVATE = seo({
  description: 'A signed-in page on Linaw PH.',
  index: false,
});

export const routes: Routes = [
  {
    path: '',
    canActivate: [homeGuard],
    loadComponent: () => import('./pages/home/home').then((m) => m.Home),
    title: 'Free Resume Builder & Job Match, Angeles City, Pampanga',
    data: seo({
      description: 'Build an ATS-friendly resume free, then see your honest match score against real openings '
        + 'in the Clark Freeport Zone, Pampanga. Nobody is auto-rejected.',
      socialTitle: 'Linaw PH, every applicant gets a seat',
    }),
  },
  {
    path: 'auth',
    loadComponent: () => import('./pages/auth/auth').then((m) => m.Auth),
    title: 'Log in or create a free account, Linaw PH',
    data: seo({
      description: 'Create a free Linaw PH account to build a resume and apply to openings in '
        + 'Angeles City and the Clark Freeport Zone, or log in to your dashboard.',
    }),
  },
  {
    path: 'browse',
    loadComponent: () => import('./pages/browse/browse').then((m) => m.Browse),
    title: 'Openings at Clark Outsourcing, Angeles City, Pampanga',
    data: seo({
      description: 'Openings at Clark Outsourcing in the Clark Freeport Zone, Pampanga, each showing the '
        + 'compatibility score your resume earns against its requirements.',
    }),
  },
  /* The nav calls this page "Openings" but the route is /browse, so /openings
     is the path a person guesses, from a bookmark, a shared message, or a QR
     code on a printed flyer. It used to reach the wildcard below and show the
     404 page, which is an expensive dead end for the one audience least likely
     to try a second URL.
     pathMatch: 'full' on purpose. Only /openings is implied by the label;
     nothing deeper ever existed under it, so redirecting /openings/anything
     would be inventing a URL space rather than honouring one. Those still land
     on the 404 page, which links straight to the openings list.
     For search: a redirect is the right answer rather than a second page with
     the same content, which would compete with /browse for the same query. */
  { path: 'openings', redirectTo: 'browse', pathMatch: 'full' },
  {
    path: 'learning-hub',
    loadComponent: () => import('./pages/learning-hub/learning-hub').then((m) => m.LearningHub),
    title: 'How to Write an ATS-Friendly Resume, Philippines Guide',
    data: seo({
      description: 'A free guide to writing a resume that applicant tracking software can actually read: '
        + 'the exact section headings, wording, file formats and what to leave out.',
      ogType: 'article',
    }),
  },
  {
    path: 'privacy',
    loadComponent: () => import('./pages/privacy/privacy').then((m) => m.Privacy),
    title: 'Privacy notice, Linaw PH',
    data: seo({
      description: 'What Linaw PH collects, why, how long it is kept, and your rights under the '
        + 'Philippine Data Privacy Act (Republic Act 10173).',
    }),
  },

  {
    path: 'seeker-dashboard', canActivate: [authGuard('seeker')], title: 'My dashboard, Linaw PH',
    loadComponent: () => import('./pages/seeker-dashboard/seeker-dashboard').then((m) => m.SeekerDashboard),
    data: PRIVATE,
  },
  {
    path: 'resume-builder', canActivate: [authGuard('seeker')], canDeactivate: [unsavedChangesGuard],
    title: 'Resume builder, Linaw PH',
    loadComponent: () => import('./pages/resume-builder/resume-builder').then((m) => m.ResumeBuilder),
    data: PRIVATE,
  },
  {
    path: 'upload-resume', canActivate: [authGuard('seeker')], title: 'Upload & analyze your resume, Linaw PH',
    loadComponent: () => import('./pages/upload-analyze/upload-analyze').then((m) => m.UploadAnalyze),
    data: PRIVATE,
  },
  {
    path: 'my-resumes', canActivate: [authGuard('seeker')], title: 'My resumes, Linaw PH',
    loadComponent: () => import('./pages/my-resumes/my-resumes').then((m) => m.MyResumes),
    data: PRIVATE,
  },
  {
    path: 'resume-print', canActivate: [authGuard()], title: 'Resume, Linaw PH',
    loadComponent: () => import('./pages/resume-print/resume-print').then((m) => m.ResumePrint),
    data: PRIVATE,
  },
  {
    path: 'admin', canActivate: [authGuard('admin')], title: 'Recruiter requests, Linaw PH',
    loadComponent: () => import('./pages/admin/admin').then((m) => m.Admin),
    data: PRIVATE,
  },
  {
    path: 'admin/metrics', canActivate: [authGuard('admin')], title: 'Platform metrics, Linaw PH',
    loadComponent: () => import('./pages/admin-metrics/admin-metrics').then((m) => m.AdminMetrics),
    data: PRIVATE,
  },
  {
    path: 'account', canActivate: [authGuard()], title: 'My account, Linaw PH',
    loadComponent: () => import('./pages/account/account').then((m) => m.Account),
    data: PRIVATE,
  },

  {
    path: 'hr-dashboard', canActivate: [authGuard('recruiter')], title: 'Recruiter dashboard, Linaw PH',
    loadComponent: () => import('./pages/hr-dashboard/hr-dashboard').then((m) => m.HrDashboard),
    data: PRIVATE,
  },
  {
    path: 'hr-applicants', canActivate: [authGuard('recruiter')], title: 'Applicants, Linaw PH',
    loadComponent: () => import('./pages/hr-applicants/hr-applicants').then((m) => m.HrApplicants),
    data: PRIVATE,
  },
  {
    path: 'hr-posting', canActivate: [authGuard('recruiter')], title: 'Post an opening, Linaw PH',
    loadComponent: () => import('./pages/hr-posting/hr-posting').then((m) => m.HrPosting),
    data: PRIVATE,
  },
  {
    path: 'hr-company', canActivate: [authGuard('recruiter')], title: 'Company profile, Linaw PH',
    loadComponent: () => import('./pages/hr-company/hr-company').then((m) => m.HrCompany),
    data: PRIVATE,
  },

  /* index: false because this page exists at every URL that does not. A 404
     that returns 200 with indexable content is a "soft 404", a static host
     cannot send a real 404 status for an SPA route, so the directive on the
     page is the only way to say it. */
  {
    path: '**',
    loadComponent: () => import('./pages/not-found/not-found').then((m) => m.NotFound),
    title: 'Page not found, Linaw PH',
    data: seo({ description: 'That page does not exist on Linaw PH.', index: false }),
  },
];
