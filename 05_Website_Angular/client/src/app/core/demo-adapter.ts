/* ============================================================
   DEMO ADAPTER, browser storage, zero setup. Port of the `demo`
   object in the PHP api.js. Seeded with Clark Outsourcing's
   real departments so all three match tiers actually demonstrate.
   ============================================================ */
import { ApiAdapter } from './adapter';
import { AnalyzedResume, ApiResult, AppStatus, Application, Company, EvidenceKind, RejectionReason, HrStats, MatchResult, Posting, RankedRow, RecommendationItem, Resume, ScreeningNote, SkillEvidence, StatusEvent, User } from './models';
import { passwordOk, PASSWORD_HINT, scoreLocal, STATUS_ORDER, ALL_STATUSES, THRESHOLDS, EDU_RANK, MAX_UPLOAD, ALLOWED_MIME, DESIGNS, EVIDENCE_KINDS, evidenceLabels } from './engine';

const KEY = 'rmph_v3_db';

/* WHICH SEED THIS BROWSER HOLDS.
 *
 * The demo database is written to localStorage on first visit and reused for
 * ever after. That is correct for a visitor's own work, and wrong for the
 * SEEDED content: a browser that first opened the site when the partner
 * company was a hotel kept showing hotel openings long after the seed became
 * Clark Outsourcing, and kept scoring them by the old arithmetic, so the site
 * on screen quietly disagreed with the site being described.
 *
 * Bump this whenever the seeded data or the scoring rules change. A mismatch
 * re-seeds, which discards anything created in demo mode; that is the right
 * trade for a demonstration build whose entire purpose is to show the seeded
 * content correctly, and demo data is disposable by construction, nothing
 * here has ever reached a database. Anything a visitor wants to keep is
 * exported from the resume itself.
 *
 * The 2026-08-25 bump is a case where NOT re-seeding would be visibly wrong:
 * users now store firstName and lastName instead of a single name, and a
 * database written by an earlier build carries the old shape. Those rows
 * would render with no name at all rather than with a stale one.
 */
const SEED_VERSION = '2026-08-25-name-split';
const SESSION = 'rmph_v3_session';
const D = 86400000;

const uid = () => 'x' + Math.random().toString(36).slice(2, 9);

/** A stored demo user. `name` is deliberately absent: it is derived from
 *  firstName + lastName on the way out (pubUser), mirroring the generated
 *  column in the real database, so the demo build cannot hold a display name
 *  that disagrees with the two parts it is supposed to be made of. */
interface DemoUser extends Omit<User, 'name'> {
  password: string;
}
interface EmailCode {
  email: string;
  purpose: 'verify' | 'reset';
  code: string;
  attempts: number;
  expiresAt: number;
}
interface Db {
  companies: Company[];
  users: DemoUser[];
  resumes: Resume[];
  postings: Posting[];
  applications: Application[];
  recruiterRequests: any[];
  emailCodes: EmailCode[];
  savedJobs: { userId: string; postingId: string; createdAt: number }[];
  deptAssignments: { companyId: string; department: string; userId: string }[];
  /** Mirrors the server's application_status_history table. Written on
   *  every status change so demo mode can show the same applicant-facing
   *  timeline as api mode rather than a feature that only half exists. */
  /** The seed this database was built from, see SEED_VERSION. */
  seedVersion?: string;
  statusHistory: { applicationId: string; from: AppStatus | null; to: AppStatus; at: number; by: 'applicant' | 'employer'; byUserId?: string | null; reason?: RejectionReason | null }[];
}

/* ------------------------------------------------------------------
   RESUME NORMALISATION

   Api mode round-trips a saved resume through PostgreSQL, and that trip
   changes it: strings are clamped to their column widths, blank optional
   fields come back absent rather than empty, and a whole section that
   holds nothing is omitted instead of returned as []. Demo mode keeps the
   object it was handed, so without this it would return `field: ''` and
   `projects: []` where api mode returns neither, a shape difference the
   printed sheet reacts to (an empty array is truthy, and would render a
   heading with nothing under it).

   These helpers reproduce that trip. Every cap matches routes/resumes.ts.
   ------------------------------------------------------------------ */
const clamp = (v: unknown, n: number) => String(v ?? '').slice(0, n);
/** Assigns only when there is something to assign, mirroring the
 *  serializer's `...(x ? { k: x } : {})`. */
function put(target: any, key: string, value: string): void {
  const v = value.trim();
  if (v) target[key] = v;
}

/** Past-deadline postings stop accepting applications, same lazy
 *  auto-close rule as server mode (deadline day itself still counts). */
function isExpired(p: Posting): boolean {
  return !!p.deadline && String(p.deadline).slice(0, 10) < new Date().toISOString().slice(0, 10);
}
const withExpired = (p: Posting): Posting => ({ ...p, expired: isExpired(p) });

function seed(): Db {
  return {
    companies: [{
      id: 'c1', name: 'Clark Outsourcing', industry: 'Business Process Outsourcing',
      location: 'Building 35 Philexcel Business Park, Clark Freeport Zone, Mabalacat, 2023 Pampanga',
      about: 'An American-owned and operated full-service business process outsourcing company in the Clark Freeport Zone, providing remote staffing, seat leasing, and a build-operate-transfer model to small and mid-sized companies worldwide. Pilot partner of this study, hiring across customer support, administration, finance and accounting, information technology, digital marketing, healthcare support, and recruitment.',
      website: 'https://clarkoutsourcing.com',
    }],
    users: [
      { id: 'u1', role: 'seeker', firstName: 'Juan', lastName: 'Dela Cruz', email: 'seeker@demo.ph', password: 'demo123', activeResumeId: 'r1', createdAt: Date.now() - D * 30 },
      { id: 'u2', role: 'recruiter', firstName: 'Maria', lastName: 'Santos', email: 'hr@demo.ph', password: 'demo123', companyId: 'c1', position: 'HR Officer', verified: true, createdAt: Date.now() - D * 60 },
      { id: 'u3', role: 'seeker', firstName: 'Ana', lastName: 'Reyes', email: 'ana@demo.ph', password: 'demo123', activeResumeId: 'r2', createdAt: Date.now() - D * 20 },
      { id: 'u4', role: 'seeker', firstName: 'Marco', lastName: 'Garcia', email: 'marco@demo.ph', password: 'demo123', activeResumeId: 'r3', createdAt: Date.now() - D * 15 },
      { id: 'u5', role: 'seeker', firstName: 'Liza', lastName: 'Cruz', email: 'liza@demo.ph', password: 'demo123', activeResumeId: 'r4', createdAt: Date.now() - D * 10 },
      { id: 'u6', role: 'admin', firstName: 'Research', lastName: 'Team', email: 'admin@demo.ph', password: 'demo123', createdAt: Date.now() - D * 90 },
      { id: 'u7', role: 'recruiter', firstName: 'Grace', lastName: 'Lopez', email: 'grace@demo.ph', password: 'demo123', companyId: 'c1', position: 'HR Officer, Customer Support', verified: true, createdAt: Date.now() - D * 55 },
    ] as DemoUser[],
    resumes: [
      // Juan carries every optional section, so the demo shows a complete
      // sheet. Kept identical to resume 1 in db/resumematch_ph.sql.
      { id: 'r1', userId: 'u1', title: 'IT, fresh graduate', template: 'chronological', design: 'classic',
        personal: { fullName: 'Juan Dela Cruz', email: 'seeker@demo.ph', phone: '0917 000 0000', address: 'San Fernando, Pampanga',
          summary: 'BS Information Technology graduate with internship experience building and maintaining public-facing web pages. Looking for an entry-level web developer role.',
          headline: 'BS Information Technology graduate', linkedin: 'linkedin.com/in/juandelacruz', portfolio: 'github.com/juandelacruz' },
        education: [{ school: 'Holy Angel University', degree: 'BS Information Technology', level: 'bachelor', year: '2026',
          field: 'Information Technology', location: 'Angeles City', honors: "Dean's Lister, 3 semesters" }],
        experience: [{ position: 'Web Development Intern', company: 'LGU San Fernando', months: 4, description: 'Built and maintained pages for the city job portal; fixed layout issues reported by staff.',
          location: 'San Fernando, Pampanga', startDate: 'Jun 2025', endDate: 'Sep 2025',
          bullets: ['Rebuilt the job posting pages so they open correctly on a phone', 'Cleared a backlog of 40+ layout issues reported by staff'] }],
        skills: ['HTML/CSS', 'JavaScript', 'Git', 'Teamwork', 'Communication'],
        /* Where each skill was used. Deliberately incomplete here and in
           db/resumematch_ph.sql, which this mirrors row for row: the two soft
           skills carry no source, so the demo shows both states in the
           recruiter's evidence panel and both halves of the arithmetic. An
           unsourced skill still counts, at UNEVIDENCED_CREDIT, not zero. */
        skillEvidence: {
          'HTML/CSS':   { kind: 'experience', ref: 'Web Development Intern, LGU San Fernando' },
          'JavaScript': { kind: 'experience', ref: 'Web Development Intern, LGU San Fernando' },
          'Git':        { kind: 'project',    ref: 'Barangay records system' },
        },
        certifications: [{ name: 'TESDA Web Development NC III', year: '2025', issuer: 'TESDA', credentialId: 'NC-III-2025-014352' }],
        projects: [{ name: 'Barangay records system', role: 'Front-end developer', startDate: 'Aug 2025', endDate: 'Feb 2026',
          description: 'Web app that replaced a paper logbook for about 1,200 residents; built with a team of four.', link: 'github.com/juandelacruz/brgy-records' }],
        languages: [{ name: 'Filipino', proficiency: 'Native' }, { name: 'English', proficiency: 'Fluent' }, { name: 'Kapampangan', proficiency: 'Native' }],
        references: [{ name: 'Engr. Roberto Lim', position: 'IT Supervisor', company: 'LGU San Fernando', email: 'rlim@example.ph', phone: '0917 555 0101' }],
        ownFile: null, updatedAt: Date.now() - D * 2 },
      { id: 'r2', userId: 'u3', title: 'Computer Science, fresh graduate', template: 'chronological', design: 'modern',
        personal: { fullName: 'Ana Reyes', email: 'ana@demo.ph', phone: '0917 111 1111', address: 'Mabalacat, Pampanga',
          summary: 'BS Computer Science graduate with coursework projects in front-end development. Seeking a junior developer role.',
          headline: 'BS Computer Science graduate' },
        education: [{ school: 'Angeles University Foundation', degree: 'BS Computer Science', level: 'bachelor', year: '2026',
          field: 'Computer Science', location: 'Angeles City' }],
        experience: [{ position: 'Capstone Developer', company: 'Angeles University Foundation', months: 3, description: 'Built a school event portal with a team of four.',
          location: 'Angeles City', startDate: 'Aug 2025', endDate: 'Oct 2025' }],
        skills: ['HTML/CSS', 'JavaScript', 'Communication', 'Teamwork'], certifications: [],
        skillEvidence: {
          'HTML/CSS':   { kind: 'project', ref: 'School event portal' },
          'JavaScript': { kind: 'project', ref: 'School event portal' },
        },
        projects: [{ name: 'School event portal', role: 'Team lead', startDate: 'Aug 2025', endDate: 'Oct 2025',
          description: 'Registration and attendance for campus events, used by three student organizations.' }],
        ownFile: null, updatedAt: Date.now() - D * 4 },
      { id: 'r3', userId: 'u4', title: 'Business Administration', template: 'chronological', design: 'minimal',
        personal: { fullName: 'Marco Garcia', email: 'marco@demo.ph', phone: '0917 222 2222', address: 'Angeles City, Pampanga',
          summary: 'Business Administration graduate with customer support internship experience at a Clark BPO.',
          headline: 'Business Administration graduate' },
        education: [{ school: 'Holy Angel University', degree: 'BS Business Administration', level: 'bachelor', year: '2025',
          field: 'Business Administration', location: 'Angeles City' }],
        experience: [{ position: 'Customer Support Intern', company: 'Clark BPO', months: 6, description: 'Handled inbound enquiries by phone and email for an offshore client account.',
          location: 'Clark Freeport Zone', startDate: 'Jan 2025', endDate: 'Jun 2025',
          bullets: ['Handled 40+ inbound enquiries per shift across phone, email and live chat', 'Logged every interaction in the client CRM with no unresolved tickets at handover'] }],
        skills: ['Customer Service', 'Communication', 'MS Office', 'English Proficiency', 'CRM Software', 'Teamwork'],
        skillEvidence: {
          'Customer Service':    { kind: 'experience',    ref: 'Customer Support Intern, Clark BPO' },
          'CRM Software':        { kind: 'experience',    ref: 'Customer Support Intern, Clark BPO' },
          'English Proficiency': { kind: 'certification', ref: 'Customer Service Excellence' },
        },
        certifications: [{ name: 'Customer Service Excellence', year: '2025', issuer: 'Clark Outsourcing' }],
        languages: [{ name: 'Filipino', proficiency: 'Native' }, { name: 'English', proficiency: 'Fluent' }, { name: 'Korean', proficiency: 'Basic' }],
        // DUAL-RESUME MODEL: the applicant's OWN file. HR views and downloads it.
        // It is NEVER parsed and NEVER scored, see the paper's delimitations.
        // extractStatus is set even on the seed: a file with no status at all
        // is indistinguishable from one that scored nothing, which is the one
        // confusion this feature must never create.
        ownFile: { name: 'Marco_Garcia_Resume.pdf', mime: 'application/pdf', size: 712, uploadedAt: Date.now() - D * 5,
          extractStatus: 'unavailable',
          dataUrl: 'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgNjEyIDc5Ml0vQ29udGVudHMgNCAwIFIvUmVzb3VyY2VzPDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+ZW5kb2JqCjQgMCBvYmo8PC9MZW5ndGggMjE1Pj5zdHJlYW0KQlQgL0YxIDE0IFRmIDYwIDc2MCBUZCAoTWFyY28gR2FyY2lhIC0gUmVzdW1lKSBUaiAwIC0yNCBUZCAoQlMgSG9zcGl0YWxpdHkgTWFuYWdlbWVudCwgSEFVIDIwMjUpIFRqIDAgLTIwIFRkIChGJkIgSW50ZXJuIC0gQ2xhcmsgaG90ZWwsIDYgbW9udGhzKSBUaiAwIC0yMCBUZCAoU2tpbGxzOiBDdXN0b21lciBTZXJ2aWNlLCBQT1MsIE1TIE9mZmljZSwgRW5nbGlzaCkgVGogRVQKZW5kc3RyZWFtIGVuZG9iago1IDAgb2JqPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj5lbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTIgMDAwMDAgbiAKMDAwMDAwMDEwMSAwMDAwMCBuIAowMDAwMDAwMjExIDAwMDAwIG4gCjAwMDAwMDA0NzMgMDAwMDAgbiAKdHJhaWxlcjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjUzNAolJUVPRg==' },
        updatedAt: Date.now() - D * 5 },
      { id: 'r4', userId: 'u5', title: 'HR & Marketing', template: 'combination', design: 'executive',
        personal: { fullName: 'Liza Cruz', email: 'liza@demo.ph', phone: '0917 333 3333', address: 'San Fernando, Pampanga',
          summary: 'Psychology graduate with HR internship exposure and social media management for a student organization.',
          headline: 'BA Psychology graduate' },
        education: [{ school: 'University of the Assumption', degree: 'BA Psychology', level: 'bachelor', year: '2025',
          field: 'Psychology', location: 'San Fernando' }],
        experience: [{ position: 'HR Intern', company: 'Manufacturing firm', months: 8, description: 'Assisted in screening, interview scheduling, and 201 filing.',
          location: 'San Fernando, Pampanga', startDate: 'Sep 2024', endDate: 'Apr 2025' }],
        skills: ['Communication', 'Recruitment', 'MS Office', 'Organization', 'Social Media'], certifications: [],
        skillEvidence: {
          'Recruitment':  { kind: 'experience', ref: 'HR Intern, Manufacturing firm' },
          'Organization': { kind: 'experience', ref: 'HR Intern, Manufacturing firm' },
        },
        ownFile: null, updatedAt: Date.now() - D * 7 },
    ] as unknown as Resume[],
    postings: [
      { id: 'p1', companyId: 'c1', title: 'Junior Web Developer', department: 'Information Technology', employmentType: 'full-time',
        description: 'Build and maintain client-facing web pages and internal tools alongside the development team. Fresh graduates are welcome to apply.',
        skills: ['HTML/CSS', 'JavaScript', 'Git', 'Teamwork'], educationLevel: 'bachelor', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 9 },
      { id: 'p2', companyId: 'c1', title: 'Technical Support Agent', department: 'Customer Support', employmentType: 'full-time',
        description: 'First-line technical support for client accounts across email, chat, and voice. Night shift.',
        skills: ['Troubleshooting', 'Windows', 'Networking', 'Communication'], educationLevel: 'bachelor', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 7 },
      { id: 'p3', companyId: 'c1', title: 'Customer Support Agent', department: 'Customer Support', employmentType: 'full-time',
        description: 'Handle customer enquiries for offshore client accounts by phone, email, and live chat.',
        skills: ['Customer Service', 'Communication', 'English Proficiency', 'CRM Software'], educationLevel: 'highschool', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 6 },
      { id: 'p4', companyId: 'c1', title: 'Data Entry and Admin Assistant', department: 'Administration', employmentType: 'full-time',
        description: 'Encode and maintain client records, prepare reports, and support the administration team.',
        skills: ['Data Entry', 'MS Office', 'Organization', 'Attention to Detail'], educationLevel: 'highschool', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 5 },
      { id: 'p5', companyId: 'c1', title: 'Accounting and Bookkeeping Support', department: 'Finance and Accounting', employmentType: 'full-time',
        description: 'Assist with accounts payable and receivable, bank reconciliation, and month-end reporting for client accounts.',
        skills: ['Bookkeeping', 'QuickBooks', 'MS Office', 'Attention to Detail'], educationLevel: 'bachelor', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 4 },
      { id: 'p6', companyId: 'c1', title: 'Social Media Manager', department: 'Digital Marketing', employmentType: 'full-time',
        description: 'Plan and publish content across client social channels; report on engagement.',
        skills: ['Social Media', 'Copywriting', 'Canva', 'Communication'], educationLevel: 'bachelor', minExperienceMonths: 6,
        deadline: new Date(Date.now() + D * 14).toISOString().slice(0, 10), // demos the "Apply by" chip
        status: 'open', createdAt: Date.now() - D * 3 },
      { id: 'p7', companyId: 'c1', title: 'Patient Coordinator', department: 'Healthcare Support', employmentType: 'full-time',
        description: 'Coordinate scheduling and records for a US healthcare client; liaise with patients by phone and email.',
        skills: ['Medical Terminology', 'Customer Service', 'Scheduling', 'English Proficiency'], educationLevel: 'bachelor', minExperienceMonths: 12, status: 'open', createdAt: Date.now() - D * 2 },
    ] as unknown as Posting[],
    applications: [
      { id: 'a1', seekerId: 'u3', resumeId: 'r2', postingId: 'p1', status: 'review', appliedAt: Date.now() - D * 3, scoreSnapshot: 82 },
      { id: 'a2', seekerId: 'u4', resumeId: 'r3', postingId: 'p1', status: 'submitted', appliedAt: Date.now() - D * 2, scoreSnapshot: 64 },
      { id: 'a3', seekerId: 'u4', resumeId: 'r3', postingId: 'p3', status: 'shortlisted', appliedAt: Date.now() - D * 4, scoreSnapshot: 91 },
      { id: 'a4', seekerId: 'u5', resumeId: 'r4', postingId: 'p5', status: 'review', appliedAt: Date.now() - D * 3, scoreSnapshot: 47 },
      { id: 'a5', seekerId: 'u5', resumeId: 'r4', postingId: 'p6', status: 'submitted', appliedAt: Date.now() - D * 1, scoreSnapshot: 73 },
    ] as unknown as Application[],
    recruiterRequests: [
      // A sample pending request, so the admin panel has something to demonstrate.
      { id: 'q1', name: 'Carlos Mendoza', email: 'carlos.mendoza@clarkoutsourcing.ph', position: 'Talent Acquisition Specialist',
        companyId: 'c1', note: 'Verify with HR head Ms. Santos, local 214.', status: 'pending', requestedAt: Date.now() - D * 1 },
    ],
    emailCodes: [],
    savedJobs: [],
    // Example routing: Santos owns IT, Lopez owns Customer Support. Every other
    // department is unassigned and falls back to notifying all recruiters.
    deptAssignments: [
      { companyId: 'c1', department: 'Information Technology', userId: 'u2' },
      { companyId: 'c1', department: 'Customer Support', userId: 'u7' },
    ],
    /* Seeded so the applicant timeline has something real to show on a
       fresh demo. Each seeded application's history ends at the status the
       application actually carries above, so the timeline and the badge can
       never disagree, a2 and a5 are still 'submitted', so they have only
       the one event that applying creates. */
    statusHistory: [
      { applicationId: 'a1', from: null, to: 'submitted', at: Date.now() - D * 3, by: 'applicant' },
      { applicationId: 'a1', from: 'submitted', to: 'review', at: Date.now() - D * 1, by: 'employer', byUserId: 'u2' },

      { applicationId: 'a2', from: null, to: 'submitted', at: Date.now() - D * 2, by: 'applicant' },

      { applicationId: 'a3', from: null, to: 'submitted', at: Date.now() - D * 4, by: 'applicant' },
      { applicationId: 'a3', from: 'submitted', to: 'review', at: Date.now() - D * 3, by: 'employer', byUserId: 'u2' },
      { applicationId: 'a3', from: 'review', to: 'shortlisted', at: Date.now() - D * 1, by: 'employer', byUserId: 'u7' },

      { applicationId: 'a4', from: null, to: 'submitted', at: Date.now() - D * 3, by: 'applicant' },
      { applicationId: 'a4', from: 'submitted', to: 'review', at: Date.now() - D * 2, by: 'employer', byUserId: 'u2' },

      { applicationId: 'a5', from: null, to: 'submitted', at: Date.now() - D * 1, by: 'applicant' },
    ],
  };
}

function load(): Db {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const db: Db = JSON.parse(raw);
      /* A database seeded by an older build is discarded rather than patched.
         The back-fills below add fields that were missing; they cannot correct
         seeded CONTENT that has since changed, and a half-updated demo is
         worse than a fresh one because nothing on screen says which it is. */
      if (db.seedVersion !== SEED_VERSION) throw new Error('stale seed');
      if (!db.emailCodes) db.emailCodes = []; // databases saved before this field existed
      if (!db.savedJobs) db.savedJobs = [];
      if (!db.deptAssignments) db.deptAssignments = []; // databases saved before department routing existed
      if (!db.statusHistory) {
        /* Saved before the applicant timeline existed. Back-fill the one
           event we can state truthfully, that the application was
           submitted, on its recorded date. Inventing the intermediate
           steps would put fabricated dates in front of an applicant, which
           is worse than a short history. */
        db.statusHistory = db.applications.map((a) => ({
          applicationId: a.id, from: null, to: 'submitted' as AppStatus, at: a.appliedAt, by: 'applicant' as const,
        }));
        persist(db);
      }
      if (!db.users.some((u) => u.role === 'admin')) {
        // databases saved before the admin panel existed get the admin account
        db.users.push({ id: 'u6', role: 'admin', firstName: 'Research', lastName: 'Team', email: 'admin@demo.ph', password: 'demo123', createdAt: Date.now() } as DemoUser);
        persist(db);
      }
      return db;
    }
  } catch { /* ignore */ }
  /* Re-seeding replaces every user row, so a session pointing at an account
     from the discarded database has to go with it, otherwise the browser is
     signed in as somebody who no longer exists. resetDemo() clears both for
     the same reason; this is the same hazard reached by a different route.
     Removing the key directly rather than calling setSession(), which is
     declared below and would also write a redundant empty value. */
  try { localStorage.removeItem(SESSION); sessionStorage.removeItem(SESSION); } catch { /* ignore */ }
  const db = seed();
  db.seedVersion = SEED_VERSION;
  persist(db);
  return db;
}
function persist(db: Db): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    throw new Error('Browser storage is full. Remove an uploaded resume file and try again.');
  }
}
/* The demo session, readable from a second tab.
 *
 * It lived in sessionStorage alone, which is per-tab. Opening the print sheet
 * from "My resumes", an <a target="_blank" rel="noopener">, therefore landed
 * on the login page, while the builder's Export PDF button (window.open, which
 * does hand the new tab a copy of sessionStorage) worked. Same destination,
 * two different outcomes, and the broken one is the path taken in a demo.
 *
 * sessionStorage stays the primary so the behaviour is unchanged in the tab
 * that signed in; localStorage is a fallback that a new tab can read, and it
 * is written and cleared in lockstep. Logging out clears both, so a shared
 * machine does not leave a session behind.
 *
 * This is demo mode: the "session" is a user id in the same browser storage
 * that already holds the whole demo database. Api mode is unaffected, there
 * the session is a signed, httpOnly cookie issued by the server. */
const sessionId = (): string | null => {
  try {
    const own = sessionStorage.getItem(SESSION);
    if (own) return own;
    const shared = localStorage.getItem(SESSION);
    // Adopt it, so this tab keeps working if the other one logs out.
    if (shared) sessionStorage.setItem(SESSION, shared);
    return shared;
  } catch { return null; }
};
const setSession = (id: string | null): void => {
  try {
    if (id) { sessionStorage.setItem(SESSION, id); localStorage.setItem(SESSION, id); }
    else { sessionStorage.removeItem(SESSION); localStorage.removeItem(SESSION); }
  } catch { /* ignore */ }
};
const apiOk = <T extends object>(data: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, ...data } as ApiResult<T>);
const apiFail = (error: string): Promise<any> => Promise.resolve({ ok: false, error });
const meRow = (db: Db): DemoUser | null => {
  const id = sessionId();
  return id ? db.users.find((u) => u.id === id) || null : null;
};
const pubUser = (u: DemoUser | null): User | null => {
  if (!u) return null;
  const c: any = { ...u };
  delete c.password;
  /* `name` is DERIVED here, exactly as the API derives it from the database's
     generated column. Storing it as well would give the demo build a second
     copy that could drift out of step with the two parts, and mode-parity
     would then be testing two different ideas of what someone is called. */
  c.name = userDisplayName(u);
  return c;
};

/** A stored user's display name, derived from the two parts exactly as the
 *  database's generated column derives it. Every read goes through this, so
 *  there is no second copy of the name to fall out of step — and no row that
 *  can be missing it, which is what broke the "who acted" line when the seed
 *  users stopped carrying a name field of their own. */
export const userDisplayName = (u: { firstName?: string; lastName?: string } | null | undefined): string =>
  `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

/** The same last-token rule the server migration uses, for the one place the
 *  demo build has a single stored name to divide: a recruiter request that
 *  predates the split. */
export function splitDemoName(full: string): { firstName: string; lastName: string } {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Unnamed', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/** Validate a submitted email code against the demo DB. Returns an error
 *  message, or null on success (in which case the code is consumed). */
function consumeCode(db: Db, email: string, purpose: 'verify' | 'reset', submitted: string): string | null {
  const row = db.emailCodes.find((c) => c.email === email && c.purpose === purpose);
  if (!row) return 'No code was requested for this email. Use “Resend code” to get one.';
  if (Date.now() > row.expiresAt) return 'That code has expired. Use “Resend code” to get a fresh one.';
  if (row.attempts >= 5) return 'Too many wrong tries for this code. Use “Resend code” to get a fresh one.';
  if (String(submitted).trim() !== row.code) {
    row.attempts += 1;
    persist(db);
    return 'That code isn’t right. Check the email and try again.';
  }
  db.emailCodes = db.emailCodes.filter((c) => !(c.email === email && c.purpose === purpose));
  return null;
}

export class DemoAdapter implements ApiAdapter {
  auth = {
    login: (email: string, password: string) => {
      const db = load();
      const u = db.users.find((x) => x.email.toLowerCase() === String(email).trim().toLowerCase() && x.password === password);
      if (!u) return apiFail("That email and password don't match an account.");
      if (u.role === 'recruiter' && !u.verified)
        return apiFail("This recruiter account isn't active yet. Accounts are activated by the research team together with the partner company's HR.");
      setSession(u.id);
      return apiOk({ user: pubUser(u)! });
    },
    /* Demo mode can't send real email, so the "sent" code is handed straight
       back (devCode) and the auth page shows it in a banner clearly labelled
       as demo behavior. Same 6-digit / 10-minute / 5-attempt rules as the
       real server, so the demonstrated flow is honest. */
    sendCode: (email: string, purpose: 'verify' | 'reset') => {
      const db = load();
      const e = String(email).trim().toLowerCase();
      const exists = db.users.some((u) => u.email.toLowerCase() === e);
      if (purpose === 'verify' && exists)
        return Promise.resolve({ ok: false, exists: true, error: 'This email already has an account.' } as any);
      if (purpose === 'reset' && !exists)
        return apiOk({ sent: true, simulated: true }); // same reply as success, no account enumeration, even in demo
      const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
      db.emailCodes = db.emailCodes.filter((c) => !(c.email === e && c.purpose === purpose));
      db.emailCodes.push({ email: e, purpose, code, attempts: 0, expiresAt: Date.now() + 10 * 60000 });
      persist(db);
      return apiOk({ sent: false, simulated: true, devCode: code });
    },
    registerSeeker: ({ firstName, lastName, email, password, code }:
      { firstName: string; lastName: string; email: string; password: string; code: string }) => {
      const db = load();
      const e = String(email).trim().toLowerCase();
      if (!passwordOk(password)) return apiFail(PASSWORD_HINT);
      if (db.users.some((u) => u.email.toLowerCase() === e))
        return Promise.resolve({ ok: false, exists: true, error: 'An account already uses this email. Log in instead.' } as any);
      const err = consumeCode(db, e, 'verify', code);
      if (err) return apiFail(err);
      const fn = String(firstName ?? '').trim().replace(/\s+/g, ' ');
      const ln = String(lastName ?? '').trim().replace(/\s+/g, ' ');
      const em = String(email).trim().toLowerCase();
      if (fn.length < 2) return apiFail('Enter your first name.');
      if (fn.length > 60) return apiFail('That first name is too long — 60 characters at most.');
      if (ln.length > 60) return apiFail('That last name is too long — 60 characters at most.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return apiFail('Enter a valid email address.');
      const user: DemoUser = { id: uid(), role: 'seeker', firstName: fn, lastName: ln,
        email: em, password, activeResumeId: null, createdAt: Date.now() };
      db.users.push(user); persist(db); setSession(user.id);
      return apiOk({ user: pubUser(user)! });
    },
    resetPassword: ({ email, code, password }: { email: string; code: string; password: string }) => {
      const db = load();
      const e = String(email).trim().toLowerCase();
      if (!passwordOk(password)) return apiFail(PASSWORD_HINT);
      const u = db.users.find((x) => x.email.toLowerCase() === e);
      if (!u) return apiFail('That code isn’t right. Check the email and try again.');
      const err = consumeCode(db, e, 'reset', code);
      if (err) return apiFail(err);
      u.password = password;
      persist(db);
      return apiOk({});
    },
    requestRecruiterAccess: ({ firstName, lastName, email, position, companyId, note }:
      { firstName: string; lastName: string; email: string; position: string; companyId: string; note?: string }) => {
      const db = load();
      const e = String(email).trim().toLowerCase();
      if (db.users.some((u) => u.email.toLowerCase() === e)) return apiFail('An account already uses this email.');
      if (db.recruiterRequests.some((r) => r.email.toLowerCase() === e && r.status === 'pending'))
        return apiFail('A request from this email is already waiting for review.');
      db.recruiterRequests.push({ id: uid(), name: `${String(firstName ?? '').trim()} ${String(lastName ?? '').trim()}`.trim(),
        email, position, companyId, note: note || '', status: 'pending', requestedAt: Date.now() });
      persist(db);
      return apiOk({});
    },
    logout: () => { setSession(null); return apiOk({}); },
    me: () => apiOk({ user: pubUser(meRow(load())) }),
    /* Change email, same proof-of-inbox flow as registration, with the
       demo's on-screen code standing in for the real email. */
    changeEmailStart: (newEmail: string, password: string) => {
      const db = load(); const u = meRow(db);
      if (!u) return apiFail('You are not signed in.');
      const e = String(newEmail).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return apiFail('Enter a valid email address.');
      if (e === u.email.toLowerCase()) return apiFail('That is already your email address.');
      if (u.password !== password) return apiFail('Your password is incorrect.');
      if (db.users.some((x) => x.email.toLowerCase() === e)) return apiFail('Another account already uses that email.');
      const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
      db.emailCodes = db.emailCodes.filter((c) => !(c.email === e && c.purpose === 'verify'));
      db.emailCodes.push({ email: e, purpose: 'verify', code, attempts: 0, expiresAt: Date.now() + 10 * 60000 });
      persist(db);
      return apiOk({ sent: false, simulated: true, devCode: code });
    },
    changeEmailConfirm: (newEmail: string, code: string) => {
      const db = load(); const u = meRow(db);
      if (!u) return apiFail('You are not signed in.');
      const e = String(newEmail).trim().toLowerCase();
      if (db.users.some((x) => x.email.toLowerCase() === e)) return apiFail('Another account already uses that email.');
      const err = consumeCode(db, e, 'verify', code);
      if (err) return apiFail(err);
      u.email = String(newEmail).trim();
      persist(db);
      return apiOk({ user: pubUser(u)! });
    },
    /* Demo mode stores the preference but sends nothing, there's no mail
       server behind a pure-browser demo, and the account page says so. */
    setEmailNotifications: (enabled: boolean) => {
      const db = load(); const u = meRow(db);
      if (!u) return apiFail('You are not signed in.');
      u.emailNotifications = enabled;
      persist(db);
      return apiOk({ user: pubUser(u)! });
    },
    /* Same rules as the server: trimmed, collapsed whitespace, 2–120
       characters, and saved resumes are left alone. */
    changeName: (firstName: string, lastName: string) => {
      const db = load(); const u = meRow(db);
      if (!u) return apiFail('You are not signed in.');
      const fn = String(firstName ?? '').trim().replace(/\s+/g, ' ');
      const ln = String(lastName ?? '').trim().replace(/\s+/g, ' ');
      if (fn.length < 2) return apiFail('Enter your first name.');
      if (fn.length > 60) return apiFail('That first name is too long — 60 characters at most.');
      if (ln.length > 60) return apiFail('That last name is too long — 60 characters at most.');
      u.firstName = fn; u.lastName = ln; persist(db);
      return apiOk({ user: pubUser(u)! });
    },
    changePassword: (current: string, next: string) => {
      const db = load(); const u = meRow(db);
      if (!u) return apiFail('You are not signed in.');
      if (u.password !== current) return apiFail('Your current password is incorrect.');
      if (!passwordOk(next)) return apiFail(PASSWORD_HINT);
      u.password = next; persist(db);
      return apiOk({});
    },
    deleteAccount: (password: string) => {
      const db = load(); const u = meRow(db);
      if (!u) return apiFail('You are not signed in.');
      if (u.password !== password) return apiFail('Password is incorrect.');
      db.resumes = db.resumes.filter((r) => r.userId !== u.id);
      db.applications = db.applications.filter((a) => a.seekerId !== u.id);
      db.users = db.users.filter((x) => x.id !== u.id);
      persist(db); setSession(null);
      return apiOk({});
    },
    // RA 10173, right of access: the person can take their data with them.
    exportMyData: () => {
      const db = load(); const u = meRow(db);
      if (!u) return apiFail('You are not signed in.');
      const myAppIds = new Set(db.applications.filter((a) => a.seekerId === u.id).map((a) => a.id));
      return apiOk({
        data: {
          exportedAt: new Date().toISOString(),
          account: pubUser(u),
          resumes: db.resumes.filter((r) => r.userId === u.id).map((r) => ({
            ...r, ownFile: r.ownFile ? { name: r.ownFile.name, mime: r.ownFile.mime, size: r.ownFile.size, note: 'Download the file itself from My resumes.' } : null,
          })),
          applications: db.applications.filter((a) => a.seekerId === u.id),
          /* Same two additions as the server's /auth/export, and for the same
             reason: the privacy notice offers "the whole lot", and the record
             of decisions taken about you, which the notice calls permanent, was not in it. `byUserId` is dropped exactly as the history
             endpoint drops it: an applicant is told an action came from the
             employer, never which member of staff. */
          applicationHistory: db.statusHistory
            .filter((h) => myAppIds.has(h.applicationId))
            .map((h) => ({
              applicationId: h.applicationId, from: h.from, to: h.to, at: h.at,
              by: h.by === 'applicant' ? 'you' : 'employer',
            })),
          savedOpenings: db.savedJobs
            .filter((s) => s.userId === u.id)
            .map((s) => {
              const p = db.postings.find((x) => x.id === s.postingId);
              return { postingId: s.postingId, title: p?.title ?? '(opening removed)',
                       department: p?.department ?? '', savedAt: s.createdAt };
            }),
        },
      });
    },
  };

  companies = {
    list: () => apiOk({ companies: load().companies }),
    get: (id: string) => {
      const c = load().companies.find((x) => x.id === id);
      return c ? apiOk({ company: c }) : apiFail('Company not found.');
    },
    update: (id: string, patch: Partial<Company>) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter' || me.companyId !== id) return apiFail('You can only edit your own company profile.');
      Object.assign(db.companies.find((c) => c.id === id)!, patch); persist(db);
      return apiOk({});
    },
  };

  resumes = {
    mine: () => {
      const db = load(); const me = meRow(db);
      if (!me) return apiFail('You are not signed in.');
      return apiOk({ resumes: db.resumes.filter((r) => r.userId === me.id).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) });
    },
    get: (id: string) => {
      const db = load(); const me = meRow(db);
      const r = db.resumes.find((x) => x.id === id);
      if (!r) return apiFail('Resume not found.');
      if (me && me.role === 'recruiter') {
        // a recruiter may read a resume only if it was actually submitted to their company
        const reachable = db.applications.some((a) => a.resumeId === id &&
          (db.postings.find((p) => p.id === a.postingId) || ({} as Posting)).companyId === me.companyId);
        return reachable ? apiOk({ resume: r }) : apiFail('You can only view resumes submitted to your company.');
      }
      if (!me || r.userId !== me.id) return apiFail('You can only view your own resumes.');
      return apiOk({ resume: r });
    },
    save: (resume: Resume) => {
      const db = load(); const me = meRow(db);
      // Seeker-only and validated, mirroring routes/resumes.ts. A recruiter
      // could build a resume here but gets a 403 from the server, and an
      // invalid design persisted in demo while the server coerced it.
      if (!me || me.role !== 'seeker') return apiFail('You are not signed in.');
      const list = (v: unknown, n: number): any[] => (Array.isArray(v) ? v : []).slice(0, n);
      const p: any = resume.personal || {};

      const personal: any = {
        fullName: p.fullName ?? '', email: p.email ?? '', phone: p.phone ?? '',
        address: p.address ?? '', summary: p.summary ?? '',
      };
      put(personal, 'headline', clamp(p.headline, 200));
      put(personal, 'linkedin', clamp(p.linkedin, 300));
      put(personal, 'portfolio', clamp(p.portfolio, 300));

      const education = list(resume.education, 20).map((e) => {
        const row: any = {
          school: clamp(e.school, 160), degree: clamp(e.degree, 160),
          // Same rule as the server: unknown claims nothing, never a degree.
          level: Object.keys(EDU_RANK).includes(e.level) ? e.level : 'none',
          year: clamp(e.year, 20),
        };
        put(row, 'field', clamp(e.field, 160));
        put(row, 'location', clamp(e.location, 160));
        put(row, 'honors', clamp(e.honors, 200));
        return row;
      });

      const experience = list(resume.experience, 30).map((e) => {
        const row: any = {
          position: clamp(e.position, 160), company: clamp(e.company, 160),
          months: Math.max(0, Math.min(720, Number(e.months) || 0)),
          description: clamp(e.description, 2000),
        };
        put(row, 'location', clamp(e.location, 160));
        put(row, 'startDate', clamp(e.startDate, 40));
        put(row, 'endDate', clamp(e.endDate, 40));
        if (e.current) row.current = true;
        const bullets = list(e.bullets, 12).map((b) => clamp(b, 300).trim()).filter(Boolean);
        if (bullets.length) row.bullets = bullets;
        return row;
      });

      const certifications = list(resume.certifications, 30).map((c) => {
        const row: any = { name: clamp(c.name, 160), year: clamp(c.year, 20) };
        put(row, 'issuer', clamp(c.issuer, 200));
        put(row, 'credentialId', clamp(c.credentialId, 120));
        return row;
      });

      // The three optional sections. A nameless entry is dropped rather than
      // stored, and a section that ends up empty is omitted entirely, both
      // exactly what the round-trip through Postgres does in api mode.
      const projects = list(resume.projects, 20).map((x) => {
        const name = clamp(x.name, 200).trim();
        if (!name) return null;
        const row: any = { name };
        put(row, 'role', clamp(x.role, 160));
        put(row, 'startDate', clamp(x.startDate, 40));
        put(row, 'endDate', clamp(x.endDate, 40));
        put(row, 'description', clamp(x.description, 2000));
        put(row, 'link', clamp(x.link, 300));
        return row;
      }).filter(Boolean);

      const languages = list(resume.languages, 20).map((x) => {
        const name = clamp(x.name, 120).trim();
        if (!name) return null;
        const row: any = { name };
        put(row, 'proficiency', clamp(x.proficiency, 120));
        return row;
      }).filter(Boolean);

      const references = list(resume.references, 10).map((x) => {
        const name = clamp(x.name, 160).trim();
        if (!name) return null;
        const row: any = { name };
        put(row, 'position', clamp(x.position, 160));
        put(row, 'company', clamp(x.company, 160));
        put(row, 'email', clamp(x.email, 190));
        put(row, 'phone', clamp(x.phone, 40));
        return row;
      }).filter(Boolean);

      /* WHERE EACH SKILL WAS USED, checked the same way the server checks it
         (routes/resumes.ts): the kind must be known and the label must match
         an entry already on this resume. A link whose entry was renamed or
         removed is dropped, which costs that skill its full credit and shows
         up as unsourced the next time the builder opens. Demo mode has to
         apply the identical rule or the same edit would score differently in
         the two modes. */
      const skills = list(resume.skills, 100).map((s) => String(s).trim().slice(0, 80)).filter(Boolean);
      const labels = evidenceLabels({ experience, projects: projects as any[], certifications, education });
      const skillEvidence: Record<string, SkillEvidence> = {};
      const rawEvidence = (resume.skillEvidence ?? {}) as Record<string, any>;
      for (const name of skills) {
        const v = rawEvidence[name];
        const kind = v?.kind as EvidenceKind;
        const ref = String(v?.ref ?? '').trim().slice(0, 200);
        if (!EVIDENCE_KINDS.includes(kind) || !ref || !labels[kind].has(ref)) continue;
        skillEvidence[name] = { kind, ref };
      }

      resume = {
        ...resume,
        skills,
        // Always assigned, even when empty: an absent map means "never asked"
        // to the engine, which would hand back the credit this withholds.
        skillEvidence,
        title: (String(resume.title ?? '').trim() || 'Untitled resume').slice(0, 120),
        template: ['chronological', 'functional', 'combination'].includes(resume.template as string)
          ? resume.template : 'chronological',
        design: DESIGNS.includes(resume.design as string) ? resume.design : 'classic',
        personal,
        education,
        experience,
        certifications,
      } as Resume;
      // Assigned separately so an empty section leaves no key behind on an
      // edit that removed its last entry.
      delete (resume as any).projects; delete (resume as any).languages; delete (resume as any).references;
      if (projects.length) resume.projects = projects;
      if (languages.length) resume.languages = languages;
      if (references.length) resume.references = references;
      const i = db.resumes.findIndex((r) => r.id === resume.id);
      try {
        if (i >= 0) {
          if (db.resumes[i].userId !== me.id) return apiFail('You can only edit your own resumes.');
          const merged: any = { ...db.resumes[i], ...resume, userId: me.id, updatedAt: Date.now() };
          // The spread carries the STORED record forward, which is what keeps
          // the uploaded ownFile (saved by a different call) attached. It would
          // also carry a section the user just emptied, so those three keys are
          // taken only from the incoming record, api mode deletes their rows
          // and then returns nothing for them.
          for (const k of ['projects', 'languages', 'references'] as const) {
            if ((resume as any)[k]) merged[k] = (resume as any)[k]; else delete merged[k];
          }
          db.resumes[i] = merged;
        } else {
          resume = { ...resume, id: resume.id || uid(), userId: me.id, updatedAt: Date.now() };
          if (resume.ownFile === undefined) resume.ownFile = null;
          db.resumes.push(resume);
          const u = db.users.find((x) => x.id === me.id)!;
          if (!u.activeResumeId) u.activeResumeId = resume.id;
        }
        persist(db);
      } catch (e: any) { return apiFail(e.message); }
      return apiOk({ resume: db.resumes.find((r) => r.id === resume.id)! });
    },
    remove: (id: string) => {
      const db = load(); const me = meRow(db);
      if (!me) return apiFail('You are not signed in.');
      const r = db.resumes.find((x) => x.id === id);
      if (!r || r.userId !== me.id) return apiFail('Resume not found.');
      if (db.applications.some((a) => a.resumeId === id))
        return apiFail("This resume is attached to an application, so it can't be deleted. The recruiter still needs to see exactly what you sent. Duplicate it and edit the copy instead.");
      db.resumes = db.resumes.filter((x) => x.id !== id);
      const u = db.users.find((x) => x.id === me.id)!;
      if (u.activeResumeId === id) u.activeResumeId = (db.resumes.find((x) => x.userId === me.id) || ({} as Resume)).id || null;
      persist(db);
      return apiOk({});
    },
    duplicate: (id: string) => {
      const db = load(); const me = meRow(db);
      const src = db.resumes.find((x) => x.id === id);
      if (!me || !src || src.userId !== me.id) return apiFail('Resume not found.');
      const copy: Resume = JSON.parse(JSON.stringify(src));
      copy.id = uid(); copy.title = src.title + ' (copy)'; copy.updatedAt = Date.now(); copy.ownFile = null;
      db.resumes.push(copy);
      try { persist(db); } catch (e: any) { return apiFail(e.message); }
      return apiOk({ resume: copy });
    },
    setActive: (resumeId: string) => {
      const db = load(); const me = meRow(db);
      if (!me) return apiFail('You are not signed in.');
      const r = db.resumes.find((x) => x.id === resumeId);
      if (!r || r.userId !== me.id) return apiFail('Resume not found.');
      db.users.find((u) => u.id === me.id)!.activeResumeId = resumeId;
      persist(db);
      return apiOk({});
    },
    uploadFile: (resumeId: string, file: File) => {
      const db = load(); const me = meRow(db);
      const r = db.resumes.find((x) => x.id === resumeId);
      if (!me || !r || r.userId !== me.id) return apiFail('Resume not found.');
      // Shared constants, not re-declared literals, the duplicates here
      // meant changing the rule in engine.ts silently left demo mode behind.
      if (file.size > MAX_UPLOAD) return apiFail('That file is larger than 2 MB. Save it at a smaller size and try again.');
      if (!ALLOWED_MIME.includes(file.type)) return apiFail('Upload a PDF, Word document, or image (JPG or PNG).');
      return new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => {
          try {
            /* Demo mode cannot read the document. There is no server here and
               no API key, and the simulated extraction that fills the builder
               on the "Upload & analyze" page is invented content, scoring
               THAT and showing the number against the applicant's real file
               would be a fabrication, not a demonstration. So demo mode says
               plainly that reading is unavailable, and no file score appears
               on either the applicant's screen or the recruiter's. Api mode
               with a GEMINI_API_KEY set is the only place a file is scored. */
            r.ownFile = { name: file.name, mime: file.type, size: file.size, uploadedAt: Date.now(),
              dataUrl: fr.result as string, extractStatus: 'unavailable' };
            r.updatedAt = Date.now();
            persist(db);
            resolve({ ok: true, ownFile: r.ownFile });
          } catch (e: any) { resolve({ ok: false, error: e.message }); }
        };
        fr.onerror = () => resolve({ ok: false, error: "That file couldn't be read. Try another one." });
        fr.readAsDataURL(file);
      });
    },
    removeFile: (resumeId: string) => {
      const db = load(); const me = meRow(db);
      const r = db.resumes.find((x) => x.id === resumeId);
      if (!me || !r || r.userId !== me.id) return apiFail('Resume not found.');
      r.ownFile = null; r.updatedAt = Date.now(); persist(db);
      return apiOk({});
    },
    fileUrl: (resumeId: string) => {
      const r = load().resumes.find((x) => x.id === resumeId);
      return r && r.ownFile ? r.ownFile.dataUrl || null : null;
    },
  };

  postings = {
    // Open AND still accepting, a past deadline hides a posting without
    // anyone closing it by hand.
    open: () => {
      const db = load();
      return apiOk({
        postings: db.postings.filter((p) => p.status === 'open' && !isExpired(p))
          .map((p) => ({ ...withExpired(p), company: db.companies.find((c) => c.id === p.companyId) })),
      });
    },
    mine: () => { // recruiter: every posting of my company, open or closed
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      return apiOk({
        postings: db.postings.filter((p) => p.companyId === me.companyId)
          .map((p) => ({
            ...withExpired(p),
            company: db.companies.find((c) => c.id === p.companyId),
            applicantCount: db.applications.filter((a) => a.postingId === p.id).length,
            newCount: db.applications.filter((a) => a.postingId === p.id && a.status === 'submitted').length,
          }))
          .sort((a, b) => b.createdAt - a.createdAt),
      });
    },
    get: (id: string) => {
      const db = load();
      const p = db.postings.find((x) => x.id === id);
      if (!p) return apiFail('That opening no longer exists.');
      return apiOk({ posting: { ...withExpired(p), company: db.companies.find((c) => c.id === p.companyId) } });
    },
    save: (posting: Partial<Posting>) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');

      // Mirrors routes/postings.ts. Without these the demo accepted an empty
      // posting that the server rejects, and a negative minExperienceMonths
      // made reqMonths <= 0, which scores EVERYONE 100% on experience.
      const title = String(posting.title ?? '').trim();
      const dept = String(posting.department ?? '').trim();
      const desc = String(posting.description ?? '').trim();
      const skills = (Array.isArray(posting.skills) ? posting.skills : [])
        .map((x: any) => String(x).trim()).filter(Boolean);
      if (title.length < 2) return apiFail('Give the opening a title.');
      if (dept === '') return apiFail('Which department is this for?');
      if (desc.length < 10) return apiFail('Describe the role in a sentence or two.');
      if (!skills.length) return apiFail("Add at least one required skill. There is nothing to match an applicant against without one.");
      posting = {
        ...posting, title, department: dept, description: desc, skills,
        educationLevel: (EDU_RANK as any)[posting.educationLevel as string] !== undefined
          ? posting.educationLevel : 'bachelor',
        employmentType: ['full-time', 'part-time', 'contract', 'internship']
          .includes(posting.employmentType as string) ? posting.employmentType : 'full-time',
        minExperienceMonths: Math.max(0, Number(posting.minExperienceMonths) || 0),
      };

      /* Per-opening weights. Same three rules as routes/postings.ts, and the
         same messages: whole numbers, each at least 10%, totalling 100. The
         demo is what gets demonstrated, so a set the server would reject must
         be rejected here too, otherwise the walkthrough shows a posting
         being saved that the real system refuses.
         Stored as whole percentages, the same units the server's column uses. */
      if (posting.weights != null) {
        const W: any = posting.weights;
        const pct = (v: unknown): number | null => {
          const n = Number(v);
          return Number.isFinite(n) && Number.isInteger(n) ? n : null;
        };
        const sk = pct(W.skills), ed = pct(W.education), ex = pct(W.experience);
        if (sk === null || ed === null || ex === null)
          return apiFail('The scoring weights must be whole numbers.');
        if (sk < 10 || ed < 10 || ex < 10)
          return apiFail('Each part of the score has to be at least 10%, a criterion cannot be switched off entirely.');
        if (sk + ed + ex !== 100)
          return apiFail(`The three weights have to add up to 100%. They currently add up to ${sk + ed + ex}%.`);
        posting = { ...posting, weights: { skills: sk, education: ed, experience: ex } };
      } else {
        posting = { ...posting, weights: null };
      }

      if (posting.deadline) {
        const d = String(posting.deadline).slice(0, 10);
        if (d < new Date().toISOString().slice(0, 10)) return apiFail("The application deadline can't be in the past.");
        posting = { ...posting, deadline: d };
      } else {
        posting = { ...posting, deadline: null };
      }
      const i = db.postings.findIndex((p) => p.id === posting.id);
      if (i >= 0) {
        if (db.postings[i].companyId !== me.companyId) return apiFail("You can only edit your own company's openings.");
        db.postings[i] = { ...db.postings[i], ...posting } as Posting;
      } else {
        // Always 'open', like the server, a caller must not create a
        // posting that is already closed.
        posting = { ...posting, id: uid(), companyId: me.companyId!, status: 'open', createdAt: Date.now() };
        db.postings.push(posting as Posting);
      }
      persist(db);
      return apiOk({ posting: db.postings.find((p) => p.id === posting.id)! });
    },
    toggle: (id: string) => {
      const db = load(); const me = meRow(db);
      const p = db.postings.find((x) => x.id === id);
      if (!me || me.role !== 'recruiter' || !p || p.companyId !== me.companyId) return apiFail('Opening not found.');
      p.status = p.status === 'open' ? 'closed' : 'open'; persist(db);
      return apiOk({ posting: p });
    },
  };

  applications = {
    apply: (resumeId: string, postingId: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'seeker') return apiFail('Sign in as a job seeker to apply.');
      const r = db.resumes.find((x) => x.id === resumeId);
      if (!r || r.userId !== me.id) return apiFail('Choose one of your own resumes.');
      const p = db.postings.find((x) => x.id === postingId);
      if (!p || p.status !== 'open') return apiFail('This opening is closed.');
      if (isExpired(p)) return apiFail('The application deadline for this opening has passed.');
      if (db.applications.some((a) => a.seekerId === me.id && a.postingId === postingId))
        return apiFail('You already applied to this position.');
      // Record the score AS IT WAS at the moment of applying, like the
      // server's score_snapshot. Without it, demo metrics recomputed every
      // historical score from the CURRENT resume, so a seeker editing their
      // resume silently rewrote the study's own past data. `r` and `p` are
      // the resume and posting already validated above.
      const app: Application = {
        id: uid(), seekerId: me.id, resumeId, postingId, status: 'submitted',
        appliedAt: Date.now(),
        scoreSnapshot: r && p ? scoreLocal(r, p).score : null,
      };
      db.applications.push(app);
      db.statusHistory.push({ applicationId: app.id, from: null, to: 'submitted', at: app.appliedAt, by: 'applicant', byUserId: me.id });
      persist(db);
      return apiOk({ application: app });
    },
    mine: () => {
      const db = load(); const me = meRow(db);
      if (!me) return apiFail('You are not signed in.');
      return apiOk({
        applications: db.applications.filter((a) => a.seekerId === me.id).map((a) => {
          const p = db.postings.find((x) => x.id === a.postingId);
          return {
            ...a,
            posting: p,
            company: db.companies.find((c) => c.id === (p || ({} as Posting)).companyId),
            resumeTitle: (db.resumes.find((r) => r.id === a.resumeId) || ({} as Resume)).title || null,
          };
        }).sort((a, b) => b.appliedAt - a.appliedAt),
      });
    },
    // The ranked shortlist. Every applicant is on it, nobody is filtered off.
    ranked: (postingId: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      const p = db.postings.find((x) => x.id === postingId);
      if (!p || p.companyId !== me.companyId) return apiFail('Opening not found.');
      const rows = db.applications.filter((a) => a.postingId === postingId).map((a) => {
        const resume = db.resumes.find((r) => r.id === a.resumeId)!;
        const seeker = db.users.find((u) => u.id === a.seekerId);
        const live = scoreLocal(resume, p);

        /* Mirrors the server: rank on the score RECORDED AT APPLICATION, not the
           live one, so a resume edited afterwards does not silently reorder the
           recruiter's shortlist. See routes/applications.ts for the reasoning —
           the demo has to behave the same or the parity suite is measuring
           nothing. */
        const ranked = a.scoreSnapshot ?? live.score;
        const tier = ranked >= THRESHOLDS.strong ? 'strong'
                   : ranked >= THRESHOLDS.related ? 'possible' : 'related';

        return {
          application: a, resume, seeker: pubUser(seeker as DemoUser),
          ...live,
          score: ranked,
          tier,
          liveScore: live.score,
          liveTier: live.tier,
          scoreDrifted: a.scoreSnapshot != null && a.scoreSnapshot !== live.score,
        };
      }).sort((x, y) => y.score - x.score || x.application.appliedAt - y.application.appliedAt);
      return apiOk({ posting: p, rows: rows as unknown as RankedRow[] });
    },
    setStatus: (applicationId: string, status: string, reason?: string | null) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      if (STATUS_ORDER.indexOf(status as any) === -1) return apiFail('Unknown status.');
      const a = db.applications.find((x) => x.id === applicationId);
      if (!a) return apiFail('Application not found.');
      const p = db.postings.find((x) => x.id === a.postingId);
      if (!p || p.companyId !== me.companyId) return apiFail('Application not found.');
      // withdrawing is the applicant's call; a recruiter can't reverse it
      if (a.status === 'withdrawn') return apiFail('This applicant withdrew their application.');
      const wasStatus = a.status;
      a.status = status as any; a.updatedAt = Date.now(); (a as any).decidedBy = me.id; // a human made this call
      // and, when they said why, the reason travels with the decision
      if (reason) (a as any).decidedReason = reason;
      if (wasStatus !== a.status) {
        db.statusHistory.push({ applicationId: a.id, from: wasStatus, to: a.status, at: a.updatedAt!, by: 'employer', byUserId: me.id,
          reason: (reason as RejectionReason) ?? null });
      }
      persist(db);
      return apiOk({ application: a });
    },
    /* The applicant's own exit, mirrors server routes/applications.ts.
       Marked, not deleted, so the recruiter sees an honest "Withdrawn"
       rather than a row that silently disappears mid-process. */
    withdraw: (applicationId: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'seeker') return apiFail('Sign in as a job seeker to withdraw an application.');
      const a = db.applications.find((x) => x.id === applicationId);
      if (!a || a.seekerId !== me.id) return apiFail('You can only withdraw your own applications.');
      if (a.status === 'withdrawn') return apiFail('This application is already withdrawn.');
      if (a.status === 'hired' || a.status === 'rejected') {
        return apiFail('This application already has a final decision, so it can no longer be withdrawn.');
      }
      const priorStatus = a.status;
      a.status = 'withdrawn'; a.updatedAt = Date.now();
      db.statusHistory.push({ applicationId: a.id, from: priorStatus, to: 'withdrawn', at: a.updatedAt!, by: 'applicant', byUserId: me.id });
      persist(db);
      return apiOk({ application: a });
    },
    /* Demo mode can't send the applicant a real email, the panel shows
       what WOULD be sent, clearly labelled. */
    invite: (applicationId: string, message: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      const msg = String(message).trim();
      if (msg.length < 10) return apiFail('Write the applicant a short message first.');
      // The server caps this too; without the cap a 5000-character message
      // "sent" in demo and failed in api mode.
      if (msg.length > 2000) return apiFail('That message is too long, keep it under 2000 characters.');
      const a = db.applications.find((x) => x.id === applicationId);
      const p = a && db.postings.find((x) => x.id === a.postingId);
      if (!a || !p || p.companyId !== me.companyId) return apiFail('Application not found.');
      return apiOk({ sent: false, simulated: true });
    },
    /* The applicant's own audit trail, mirrors server routes/applications.ts.
       Visible to the applicant it belongs to and to recruiters at the company
       that owns the posting; one identical message for "no such application"
       and "not yours", so it cannot be used to probe which ids exist. */
    /* SCREENING NOTES, recruiter-only, mirroring routes/applications.ts.
       Held on the demo database like everything else here, and returned by no
       seeker-facing method, so the demo cannot accidentally show an applicant
       something the real system would never show them. */
    notes: (applicationId: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      const a = db.applications.find((x) => x.id === applicationId);
      if (!a) return apiFail('Application not found.');
      const p = db.postings.find((x) => x.id === a.postingId);
      if (!p || p.companyId !== me.companyId) return apiFail('Application not found.');
      const all: any[] = (db as any).notes ?? [];
      return apiOk({
        notes: all
          .filter((n) => n.applicationId === applicationId)
          .sort((x, y) => y.at - x.at)
          .map((n) => ({
            id: n.id,
            body: n.body,
            at: n.at,
            authorName: userDisplayName(db.users.find((u) => u.id === n.authorId)) || 'A former colleague',
            mine: n.authorId === me.id,
          })),
      });
    },
    noteAdd: (applicationId: string, body: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      const text = String(body ?? '').trim().slice(0, 2000);
      if (!text) return apiFail('Write something first.');
      const a = db.applications.find((x) => x.id === applicationId);
      if (!a) return apiFail('Application not found.');
      const p = db.postings.find((x) => x.id === a.postingId);
      if (!p || p.companyId !== me.companyId) return apiFail('Application not found.');
      (db as any).notes = (db as any).notes ?? [];
      const id = 'n' + Date.now().toString(36);
      (db as any).notes.push({ id, applicationId, authorId: me.id, body: text, at: Date.now() });
      persist(db);
      return apiOk({ id });
    },
    /* Author-only, as on the server: a colleague quietly deleting someone
       else's observation would make the notes untrustworthy to the people who
       have to rely on them. */
    noteDelete: (noteId: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      const all: any[] = (db as any).notes ?? [];
      const n = all.find((x) => x.id === noteId);
      if (!n) return apiFail('Note not found.');
      if (n.authorId !== me.id) return apiFail('You can only delete your own notes.');
      (db as any).notes = all.filter((x) => x.id !== noteId);
      persist(db);
      return apiOk({});
    },
    history: (applicationId: string) => {
      const db = load(); const me = meRow(db);
      if (!me) return apiFail('You are not signed in.');
      const a = db.applications.find((x) => x.id === applicationId);
      const p = a && db.postings.find((x) => x.id === a.postingId);
      const mine = !!a && a.seekerId === me.id;
      const atMyCompany = !!p && (me.role === 'recruiter' || me.role === 'admin') && p.companyId === me.companyId;
      if (!a || !(mine || atMyCompany)) return apiFail('Application not found.');
      /* Who made each change is disclosed by audience, exactly as the server
         does it: the employer's own staff get names (that is what changed_by
         is for), the applicant never does. An applicant reading their own
         history gets no names even if they also work here, the narrower
         disclosure wins. */
      const maySeeNames = atMyCompany && !mine;
      const events: StatusEvent[] = db.statusHistory
        .filter((h) => h.applicationId === applicationId)
        .sort((x, y) => x.at - y.at)
        .map((h) => {
          const e: StatusEvent = { from: h.from, to: h.to, at: h.at, by: h.by };
          if (maySeeNames && h.by === 'employer' && h.byUserId) {
            const actor = db.users.find((u) => u.id === h.byUserId);
            if (actor) e.byName = userDisplayName(actor);
          }
          /* The reason goes to BOTH audiences, unlike the name above, see
             routes/applications.ts for why the two gates differ. The applicant
             learns what was decided; they do not learn which staff member
             decided it. */
          if (h.reason) e.reason = h.reason;
          return e;
        });
      return apiOk({ events });
    },
  };

  saved = {
    list: () => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'seeker') return apiFail('Sign in as a job seeker.');
      const mine = db.savedJobs.filter((s) => s.userId === me.id).sort((a, b) => b.createdAt - a.createdAt);
      return apiOk({
        postings: mine
          .map((s) => db.postings.find((p) => p.id === s.postingId))
          .filter((p): p is Posting => !!p)
          .map((p) => ({ ...withExpired(p), company: db.companies.find((c) => c.id === p.companyId) })),
      });
    },
    toggle: (postingId: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'seeker') return apiFail('Sign in as a job seeker.');
      const i = db.savedJobs.findIndex((s) => s.userId === me.id && s.postingId === postingId);
      if (i >= 0) {
        db.savedJobs.splice(i, 1);
        persist(db);
        return apiOk({ saved: false });
      }
      if (!db.postings.some((p) => p.id === postingId)) return apiFail('Opening not found.');
      db.savedJobs.push({ userId: me.id, postingId, createdAt: Date.now() });
      persist(db);
      return apiOk({ saved: true });
    },
  };

  /* Researcher aggregates. Demo mode computes them live from the browser
     database; no status history exists here, so time-to-decision is
     approximated from updatedAt where present. */
  metrics = {
    summary: () => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'admin') return apiFail("You don't have access to that.");
      const T = THRESHOLDS;
      const scored = db.applications.map((a) => {
        // Prefer the snapshot taken when they applied. Older demo databases
        // predate it, so fall back to a live score rather than dropping the
        // row entirely: the number is then approximate, not wrong.
        if (typeof a.scoreSnapshot === 'number') return { a, score: a.scoreSnapshot };
        const r = db.resumes.find((x) => x.id === a.resumeId);
        const p = db.postings.find((x) => x.id === a.postingId);
        return r && p ? { a, score: scoreLocal(r, p).score } : null;
      }).filter((x): x is { a: Application; score: number } => !!x);

      const buckets = Array.from({ length: 10 }, (_, i) => ({
        range: i === 9 ? '90–100' : `${i * 10}–${i * 10 + 9}`, count: 0,
      }));
      for (const s of scored) buckets[Math.min(Math.floor(s.score / 10), 9)].count++;

      const funnel: Record<string, number> = { submitted: 0, review: 0, shortlisted: 0, rejected: 0, hired: 0 };
      for (const a of db.applications) funnel[a.status] = (funnel[a.status] || 0) + 1;

      const decided = db.applications.filter((a) => a.status !== 'submitted');
      const withTimes = decided.filter((a) => (a as any).updatedAt && a.appliedAt);
      const avgHours = withTimes.length
        ? Math.round(withTimes.reduce((t, a) => t + ((a as any).updatedAt - a.appliedAt), 0) / withTimes.length / 360000) / 10
        : null;

      return apiOk({
        metrics: {
          generatedAt: new Date().toISOString(),
          thresholds: T,
          volumes: {
            seekers: db.users.filter((u) => u.role === 'seeker').length,
            recruiters: db.users.filter((u) => u.role === 'recruiter').length,
            resumes: db.resumes.length,
            postings: db.postings.length,
            openPostings: db.postings.filter((p) => p.status === 'open' && !isExpired(p)).length,
            applications: db.applications.length,
            savedJobs: db.savedJobs.length,
          },
          scores: {
            average: scored.length ? Math.round((scored.reduce((t, s) => t + s.score, 0) / scored.length) * 10) / 10 : null,
            buckets,
          },
          tiersAtApplication: {
            strong: scored.filter((s) => s.score >= T.strong).length,
            possible: scored.filter((s) => s.score >= T.related && s.score < T.strong).length,
            related: scored.filter((s) => s.score < T.related).length,
          },
          funnel,
          responsiveness: { applicationsDecided: decided.length, avgHoursToFirstDecision: avgHours },
        },
      });
    },
  };

  match = {
    score: (resumeId: string, postingId: string) => {
      const db = load(); const me = meRow(db);
      // Mirrors routes/match.ts. This had no check at all, so a signed-out
      // visitor could score any resume against any posting.
      if (!me) return apiFail('You are not signed in.');
      const r = db.resumes.find((x) => x.id === resumeId), p = db.postings.find((x) => x.id === postingId);
      if (!r || !p) return apiFail('Not found.');
      if (me.role === 'recruiter') {
        const submitted = db.applications.some((a) => a.resumeId === resumeId
          && db.postings.find((x) => x.id === a.postingId)?.companyId === me.companyId);
        if (!submitted) return apiFail('You can only score resumes submitted to your company.');
      } else if (r.userId !== me.id) {
        return apiFail('You can only score your own resumes.');
      }
      return apiOk(scoreLocal(r, p) as unknown as MatchResult);
    },
    // Three tiers. The third exists so a low score is a redirection, not a rejection.
    recommendations: () => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'seeker') return apiFail('You are not signed in.');
      const resume = db.resumes.find((r) => r.id === me.activeResumeId) || db.resumes.find((r) => r.userId === me.id);
      const openNow = db.postings.filter((p) => p.status === 'open' && !isExpired(p)).length;
      if (!resume) return apiOk({ resume: null, strong: [], possible: [], related: [], openCount: openNow });
      const applied = db.applications.filter((a) => a.seekerId === me.id).map((a) => a.postingId);
      const scored = db.postings.filter((p) => p.status === 'open' && !isExpired(p)).map((p) => ({
        posting: p,
        company: db.companies.find((c) => c.id === p.companyId) || null,
        applied: applied.indexOf(p.id) !== -1,
        ...scoreLocal(resume, p),
      })).sort((a, b) => b.score - a.score);
      return apiOk({
        resume,
        strong: scored.filter((s) => s.tier === 'strong') as unknown as RecommendationItem[],
        possible: scored.filter((s) => s.tier === 'possible') as unknown as RecommendationItem[],
        // a related role must share at least one real skill, or it's noise rather than a suggestion
        related: scored.filter((s) => s.tier === 'related' && s.matchedSkills.length > 0) as unknown as RecommendationItem[],
        // every open posting, including the ones the tiers dropped — see adapter.ts
        openCount: openNow,
      });
    },
  };

  stats = {
    hr: () => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      const mine = db.postings.filter((p) => p.companyId === me.companyId);
      const ids = mine.map((p) => p.id);
      const apps = db.applications.filter((a) => ids.indexOf(a.postingId) !== -1);
      const byStatus: any = {}; ALL_STATUSES.forEach((s) => byStatus[s] = apps.filter((a) => a.status === s).length);
      return apiOk({
        stats: {
          openPostings: mine.filter((p) => p.status === 'open').length,
          totalPostings: mine.length,
          totalApplicants: apps.length,
          needsReview: apps.filter((a) => a.status === 'submitted').length,
          byStatus,
        } as HrStats,
      });
    },
  };

  /* The research-team panel. Approving a request creates the verified
     recruiter account with an unguessable placeholder password, the new
     recruiter sets their own via "Forgot password", exactly like server
     mode (demo shows the code on screen). */
  admin = {
    requests: () => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'admin') return apiFail("You don't have access to that.");
      return apiOk({ requests: this.reqList(db) });
    },
    approve: (id: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'admin') return apiFail("You don't have access to that.");
      const r = db.recruiterRequests.find((x) => x.id === id);
      if (!r) return apiFail('Request not found.');
      if (r.status !== 'pending') return apiFail('This request was already handled.');
      if (db.users.some((u) => u.email.toLowerCase() === r.email.toLowerCase()))
        return apiFail('An account already uses this email. Decline the request instead.');
      db.users.push({
        id: uid(), role: 'recruiter', ...splitDemoName(r.name), email: r.email,
        password: uid() + uid() + uid(), // placeholder; they set their own via Forgot password
        companyId: r.companyId, position: r.position || 'Recruiter', verified: true, createdAt: Date.now(),
      } as DemoUser);
      r.status = 'approved';
      persist(db);
      return apiOk({ requests: this.reqList(db) });
    },
    decline: (id: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'admin') return apiFail("You don't have access to that.");
      const r = db.recruiterRequests.find((x) => x.id === id);
      if (!r) return apiFail('Request not found.');
      if (r.status !== 'pending') return apiFail('This request was already handled.');
      r.status = 'declined';
      persist(db);
      return apiOk({ requests: this.reqList(db) });
    },
    recruiters: () => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'admin') return apiFail("You don't have access to that.");
      return apiOk({
        recruiters: db.users.filter((u) => u.role === 'recruiter').map((u) => ({
          id: u.id, name: userDisplayName(u), email: u.email, position: u.position || '',
          companyName: db.companies.find((c) => c.id === u.companyId)?.name || '—',
          verified: !!u.verified, createdAt: u.createdAt, lastLoginAt: null,
        })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      });
    },
    deptAssignments: () => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'admin') return apiFail("You don't have access to that.");
      return apiOk({ companies: this.routingList(db) });
    },
    assignDepartment: (companyId: string, department: string, userId: string | null) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'admin') return apiFail("You don't have access to that.");
      const dept = (department || '').trim();
      if (!companyId || !dept) return apiFail('Pick a company and a department.');
      if (!db.companies.some((c) => c.id === companyId)) return apiFail('That company no longer exists.');
      // clear any existing owner for this department first
      db.deptAssignments = db.deptAssignments.filter(
        (a) => !(a.companyId === companyId && a.department.trim().toLowerCase() === dept.toLowerCase()),
      );
      if (userId) {
        const owner = db.users.find(
          (u) => u.id === userId && u.role === 'recruiter' && u.companyId === companyId && u.verified,
        );
        if (!owner) return apiFail('Pick a verified recruiter from that company.');
        db.deptAssignments.push({ companyId, department: dept, userId });
      }
      persist(db);
      return apiOk({ companies: this.routingList(db) });
    },
  };

  /** Build the per-company department-routing view the admin panel renders. */
  private routingList(db: Db) {
    const companyIds = Array.from(new Set(db.postings.map((p) => p.companyId)));
    return companyIds.map((cid) => ({
      id: cid,
      name: db.companies.find((c) => c.id === cid)?.name || '—',
      departments: Array.from(new Set([
        ...db.postings.filter((p) => p.companyId === cid).map((p) => (p.department || '').trim()).filter(Boolean),
        ...db.deptAssignments.filter((a) => a.companyId === cid).map((a) => a.department),
      ])).sort(),
      recruiters: db.users
        .filter((u) => u.role === 'recruiter' && u.companyId === cid && u.verified)
        .map((u) => ({ id: u.id, name: userDisplayName(u) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      assignments: db.deptAssignments
        .filter((a) => a.companyId === cid)
        .map((a) => ({ department: a.department, userId: a.userId, userName: userDisplayName(db.users.find((u) => u.id === a.userId)) || '—' })),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  private reqList(db: Db) {
    return db.recruiterRequests.map((r) => ({
      id: r.id, name: r.name, email: r.email, position: r.position || '',
      companyId: r.companyId ?? null,
      companyName: db.companies.find((c) => c.id === r.companyId)?.name || '—',
      note: r.note || '', status: r.status, requestedAt: r.requestedAt,
    })).sort((a: any, b: any) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.requestedAt - a.requestedAt);
  }

  analyze = {
    /** Nothing reads anything in demo mode, so the consent notice says exactly
     *  that. The demo build has no server and no key: the file never leaves the
     *  browser, and a panelist clicking around sends no document anywhere. */
    reader: (): Promise<ApiResult<{ reader: 'rules' | 'gemini' | 'demo'; configured: boolean }>> =>
      Promise.resolve({ ok: true, reader: 'demo' as const, configured: true }),

    /** Demo mode can't call a real AI, so this returns a clearly-labeled
     *  simulated extraction after a short delay, enough to demonstrate the
     *  whole upload → review → score journey offline. */
    resume: (file: File): Promise<ApiResult<{ resume: AnalyzedResume; provider?: string; simulated?: boolean }>> => {
      const db = load();
      const me = meRow(db);
      if (!me || me.role !== 'seeker') return apiFail('Sign in as a job seeker to analyze a resume.');
      if (file.size > 2 * 1024 * 1024) return apiFail('That file is larger than 2 MB. Save it at a smaller size and try again.');

      // Sample a few in-demand skills from the open postings so the simulated
      // extraction produces real matches on the dashboard.
      const demanded: Record<string, number> = {};
      db.postings.filter((p) => p.status === 'open').forEach((p) => p.skills.forEach((s) => { demanded[s] = (demanded[s] || 0) + 1; }));
      const topSkills = Object.keys(demanded).sort((a, b) => demanded[b] - demanded[a]).slice(0, 5);

      const baseName = file.name.replace(/\.[^.]+$/, '');
      const resume: AnalyzedResume = {
        title: baseName || 'Uploaded resume',
        template: 'chronological',
        personal: {
          fullName: userDisplayName(me),
          email: me.email,
          phone: '',
          address: '',
          summary: `Motivated applicant with practical experience and a growing skill set, imported from ${file.name}.`,
        },
        education: [{ school: 'Holy Angel University', degree: 'BS Information Technology', level: 'bachelor', year: '2025' }],
        experience: [{ position: 'Working Student / Intern', company: 'Local business', months: 6, description: 'Assisted daily operations and customer-facing tasks.' }],
        skills: topSkills.length ? topSkills : ['Communication', 'Teamwork', 'MS Office'],
        certifications: [],
      };
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, resume, provider: 'demo', simulated: true }), 1400));
    },
  };

  resetDemo() {
    // setSession(null) rather than a bare removeItem: the session now has a
    // localStorage copy so a second tab can read it, and a reset that cleared
    // only one of the two would leave the browser signed in as a user the
    // wiped database no longer contains.
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    setSession(null);
    return apiOk({});
  }
}
