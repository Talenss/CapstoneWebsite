import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/home/home').then((m) => m.Home), title: 'ResumeMatch PH — Every applicant gets a seat.' },
  { path: 'auth', loadComponent: () => import('./pages/auth/auth').then((m) => m.Auth), title: 'Log in or create an account — ResumeMatch PH' },
  { path: 'browse', loadComponent: () => import('./pages/browse/browse').then((m) => m.Browse), title: 'Openings — ResumeMatch PH' },
  { path: 'learning-hub', loadComponent: () => import('./pages/learning-hub/learning-hub').then((m) => m.LearningHub), title: 'Learning hub — ResumeMatch PH' },
  { path: 'privacy', loadComponent: () => import('./pages/privacy/privacy').then((m) => m.Privacy), title: 'Privacy notice — ResumeMatch PH' },

  {
    path: 'seeker-dashboard', canActivate: [authGuard('seeker')], title: 'My dashboard — ResumeMatch PH',
    loadComponent: () => import('./pages/seeker-dashboard/seeker-dashboard').then((m) => m.SeekerDashboard),
  },
  {
    path: 'resume-builder', canActivate: [authGuard('seeker')], title: 'Resume builder — ResumeMatch PH',
    loadComponent: () => import('./pages/resume-builder/resume-builder').then((m) => m.ResumeBuilder),
  },
  {
    path: 'upload-resume', canActivate: [authGuard('seeker')], title: 'Upload & analyze your resume — ResumeMatch PH',
    loadComponent: () => import('./pages/upload-analyze/upload-analyze').then((m) => m.UploadAnalyze),
  },
  {
    path: 'my-resumes', canActivate: [authGuard('seeker')], title: 'My resumes — ResumeMatch PH',
    loadComponent: () => import('./pages/my-resumes/my-resumes').then((m) => m.MyResumes),
  },
  {
    path: 'resume-print', canActivate: [authGuard()], title: 'Resume — ResumeMatch PH',
    loadComponent: () => import('./pages/resume-print/resume-print').then((m) => m.ResumePrint),
  },
  {
    path: 'admin', canActivate: [authGuard('admin')], title: 'Recruiter requests — ResumeMatch PH',
    loadComponent: () => import('./pages/admin/admin').then((m) => m.Admin),
  },
  {
    path: 'account', canActivate: [authGuard()], title: 'My account — ResumeMatch PH',
    loadComponent: () => import('./pages/account/account').then((m) => m.Account),
  },

  {
    path: 'hr-dashboard', canActivate: [authGuard('recruiter')], title: 'Recruiter dashboard — ResumeMatch PH',
    loadComponent: () => import('./pages/hr-dashboard/hr-dashboard').then((m) => m.HrDashboard),
  },
  {
    path: 'hr-applicants', canActivate: [authGuard('recruiter')], title: 'Applicants — ResumeMatch PH',
    loadComponent: () => import('./pages/hr-applicants/hr-applicants').then((m) => m.HrApplicants),
  },
  {
    path: 'hr-posting', canActivate: [authGuard('recruiter')], title: 'Post an opening — ResumeMatch PH',
    loadComponent: () => import('./pages/hr-posting/hr-posting').then((m) => m.HrPosting),
  },
  {
    path: 'hr-company', canActivate: [authGuard('recruiter')], title: 'Company profile — ResumeMatch PH',
    loadComponent: () => import('./pages/hr-company/hr-company').then((m) => m.HrCompany),
  },

  { path: '**', loadComponent: () => import('./pages/not-found/not-found').then((m) => m.NotFound), title: 'Page not found — ResumeMatch PH' },
];
