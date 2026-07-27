/* ============================================================
   DEMO ADAPTER — browser storage, zero setup. Port of the `demo`
   object in 04_Website/app/assets/api.js. Seeded with Royce's real
   departments so all three match tiers actually demonstrate.
   ============================================================ */
import { ApiAdapter } from './adapter';
import { AnalyzedResume, ApiResult, Application, Company, HrStats, MatchResult, Posting, RankedRow, RecommendationItem, Resume, User } from './models';
import { passwordOk, PASSWORD_HINT, scoreLocal, STATUS_ORDER, ALL_STATUSES, THRESHOLDS, EDU_RANK, MAX_UPLOAD, ALLOWED_MIME } from './engine';

const KEY = 'rmph_v3_db';
const SESSION = 'rmph_v3_session';
const D = 86400000;

const uid = () => 'x' + Math.random().toString(36).slice(2, 9);

interface DemoUser extends User {
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
}

/** Past-deadline postings stop accepting applications — same lazy
 *  auto-close rule as server mode (deadline day itself still counts). */
function isExpired(p: Posting): boolean {
  return !!p.deadline && String(p.deadline).slice(0, 10) < new Date().toISOString().slice(0, 10);
}
const withExpired = (p: Posting): Posting => ({ ...p, expired: isExpired(p) });

function seed(): Db {
  return {
    companies: [{
      id: 'c1', name: 'Royce Hotel & Casino', industry: 'Hospitality & Gaming',
      location: 'Manuel A. Roxas Highway, Clark Freeport Zone, Mabalacat, Pampanga',
      about: 'An integrated hotel and entertainment destination in Clark Freeport Zone — 500 rooms across two buildings, ten dining venues, event ballrooms, a spa, and a gaming floor. Pilot partner of this study, hiring across front office, food & beverage, housekeeping, IT, human resources, and marketing.',
      website: 'https://www.roycehotelandcasino.com',
    }],
    users: [
      { id: 'u1', role: 'seeker', name: 'Juan Dela Cruz', email: 'seeker@demo.ph', password: 'demo123', activeResumeId: 'r1', createdAt: Date.now() - D * 30 },
      { id: 'u2', role: 'recruiter', name: 'Maria Santos', email: 'hr@demo.ph', password: 'demo123', companyId: 'c1', position: 'HR Officer', verified: true, createdAt: Date.now() - D * 60 },
      { id: 'u3', role: 'seeker', name: 'Ana Reyes', email: 'ana@demo.ph', password: 'demo123', activeResumeId: 'r2', createdAt: Date.now() - D * 20 },
      { id: 'u4', role: 'seeker', name: 'Marco Garcia', email: 'marco@demo.ph', password: 'demo123', activeResumeId: 'r3', createdAt: Date.now() - D * 15 },
      { id: 'u5', role: 'seeker', name: 'Liza Cruz', email: 'liza@demo.ph', password: 'demo123', activeResumeId: 'r4', createdAt: Date.now() - D * 10 },
      { id: 'u6', role: 'admin', name: 'Research Team', email: 'admin@demo.ph', password: 'demo123', createdAt: Date.now() - D * 90 },
      { id: 'u7', role: 'recruiter', name: 'Grace Lopez', email: 'grace@demo.ph', password: 'demo123', companyId: 'c1', position: 'HR Officer — Front Office', verified: true, createdAt: Date.now() - D * 55 },
    ] as DemoUser[],
    resumes: [
      { id: 'r1', userId: 'u1', title: 'IT — fresh graduate', template: 'chronological', design: 'classic',
        personal: { fullName: 'Juan Dela Cruz', email: 'seeker@demo.ph', phone: '0917 000 0000', address: 'San Fernando, Pampanga',
          summary: 'BS Information Technology graduate with internship experience building and maintaining public-facing web pages. Looking for an entry-level web developer role.' },
        education: [{ school: 'Holy Angel University', degree: 'BS Information Technology', level: 'bachelor', year: '2026' }],
        experience: [{ position: 'Web Development Intern', company: 'LGU San Fernando', months: 4, description: 'Built and maintained pages for the city job portal; fixed layout issues reported by staff.' }],
        skills: ['HTML/CSS', 'JavaScript', 'MySQL', 'Teamwork', 'Communication'],
        certifications: [{ name: 'TESDA Web Development NC III', year: '2025' }],
        ownFile: null, updatedAt: Date.now() - D * 2 },
      { id: 'r2', userId: 'u3', title: 'Computer Science — fresh graduate', template: 'chronological', design: 'modern',
        personal: { fullName: 'Ana Reyes', email: 'ana@demo.ph', phone: '0917 111 1111', address: 'Mabalacat, Pampanga',
          summary: 'BS Computer Science graduate with coursework projects in front-end development. Seeking a junior developer role.' },
        education: [{ school: 'Angeles University Foundation', degree: 'BS Computer Science', level: 'bachelor', year: '2026' }],
        experience: [{ position: 'Capstone Developer', company: 'Angeles University Foundation', months: 3, description: 'Built a school event portal with a team of four.' }],
        skills: ['HTML/CSS', 'JavaScript', 'Communication', 'Teamwork'], certifications: [],
        ownFile: null, updatedAt: Date.now() - D * 4 },
      { id: 'r3', userId: 'u4', title: 'Hospitality Management', template: 'chronological', design: 'minimal',
        personal: { fullName: 'Marco Garcia', email: 'marco@demo.ph', phone: '0917 222 2222', address: 'Angeles City, Pampanga',
          summary: 'Hospitality Management graduate with food & beverage internship experience at a Clark hotel.' },
        education: [{ school: 'Holy Angel University', degree: 'BS Hospitality Management', level: 'bachelor', year: '2025' }],
        experience: [{ position: 'F&B Intern', company: 'Clark hotel', months: 6, description: 'Served 60+ covers per shift; handled POS billing and table turnover.' }],
        skills: ['Customer Service', 'Communication', 'MS Office', 'English Proficiency', 'POS', 'Teamwork', 'Food Safety'],
        certifications: [{ name: 'Food Safety Training', year: '2025' }],
        // DUAL-RESUME MODEL: the applicant's OWN file. HR views and downloads it.
        // It is NEVER parsed and NEVER scored — see the paper's delimitations.
        ownFile: { name: 'Marco_Garcia_Resume.pdf', mime: 'application/pdf', size: 712, uploadedAt: Date.now() - D * 5,
          dataUrl: 'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgNjEyIDc5Ml0vQ29udGVudHMgNCAwIFIvUmVzb3VyY2VzPDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+ZW5kb2JqCjQgMCBvYmo8PC9MZW5ndGggMjE1Pj5zdHJlYW0KQlQgL0YxIDE0IFRmIDYwIDc2MCBUZCAoTWFyY28gR2FyY2lhIC0gUmVzdW1lKSBUaiAwIC0yNCBUZCAoQlMgSG9zcGl0YWxpdHkgTWFuYWdlbWVudCwgSEFVIDIwMjUpIFRqIDAgLTIwIFRkIChGJkIgSW50ZXJuIC0gQ2xhcmsgaG90ZWwsIDYgbW9udGhzKSBUaiAwIC0yMCBUZCAoU2tpbGxzOiBDdXN0b21lciBTZXJ2aWNlLCBQT1MsIE1TIE9mZmljZSwgRW5nbGlzaCkgVGogRVQKZW5kc3RyZWFtIGVuZG9iago1IDAgb2JqPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj5lbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTIgMDAwMDAgbiAKMDAwMDAwMDEwMSAwMDAwMCBuIAowMDAwMDAwMjExIDAwMDAwIG4gCjAwMDAwMDA0NzMgMDAwMDAgbiAKdHJhaWxlcjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjUzNAolJUVPRg==' },
        updatedAt: Date.now() - D * 5 },
      { id: 'r4', userId: 'u5', title: 'HR & Marketing', template: 'combination', design: 'executive',
        personal: { fullName: 'Liza Cruz', email: 'liza@demo.ph', phone: '0917 333 3333', address: 'San Fernando, Pampanga',
          summary: 'Psychology graduate with HR internship exposure and social media management for a student organization.' },
        education: [{ school: 'University of the Assumption', degree: 'BA Psychology', level: 'bachelor', year: '2025' }],
        experience: [{ position: 'HR Intern', company: 'Manufacturing firm', months: 8, description: 'Assisted in screening, interview scheduling, and 201 filing.' }],
        skills: ['Communication', 'Recruitment', 'MS Office', 'Organization', 'Social Media'], certifications: [],
        ownFile: null, updatedAt: Date.now() - D * 7 },
    ] as unknown as Resume[],
    postings: [
      { id: 'p1', companyId: 'c1', title: 'Junior Web Developer', department: 'IT', employmentType: 'full-time',
        description: 'Maintain the hotel website, online booking pages, and internal web tools under the IT supervisor. Fresh graduates are welcome to apply.',
        skills: ['HTML/CSS', 'JavaScript', 'MySQL', 'Teamwork'], educationLevel: 'bachelor', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 9 },
      { id: 'p2', companyId: 'c1', title: 'IT Support Associate', department: 'IT', employmentType: 'full-time',
        description: 'First-line technical support for the front office, gaming floor, and back-office systems.',
        skills: ['Troubleshooting', 'Windows', 'Networking', 'Communication'], educationLevel: 'bachelor', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 7 },
      { id: 'p3', companyId: 'c1', title: 'Front Office Associate', department: 'Front Office', employmentType: 'full-time',
        description: 'Handle guest check-in and check-out, reservations, and inquiries at the front desk of the Premium Building.',
        skills: ['Customer Service', 'Communication', 'MS Office', 'English Proficiency'], educationLevel: 'bachelor', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 6 },
      { id: 'p4', companyId: 'c1', title: 'F&B Service Attendant', department: 'Food & Beverage', employmentType: 'full-time',
        description: 'Serve guests across the hotel restaurants and banquet events; uphold food safety standards.',
        skills: ['Customer Service', 'Teamwork', 'Food Safety', 'POS'], educationLevel: 'highschool', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 5 },
      { id: 'p5', companyId: 'c1', title: 'HR Assistant', department: 'Human Resources', employmentType: 'full-time',
        description: 'Assist in recruitment scheduling, 201 files, and onboarding of new hires.',
        skills: ['Communication', 'MS Office', 'Recruitment', 'Organization'], educationLevel: 'bachelor', minExperienceMonths: 0, status: 'open', createdAt: Date.now() - D * 4 },
      { id: 'p6', companyId: 'c1', title: 'Marketing Associate', department: 'Marketing', employmentType: 'full-time',
        description: 'Support promotions, events, and social media for the hotel and casino.',
        skills: ['Social Media', 'Copywriting', 'Canva', 'Communication'], educationLevel: 'bachelor', minExperienceMonths: 6,
        deadline: new Date(Date.now() + D * 14).toISOString().slice(0, 10), // demos the "Apply by" chip
        status: 'open', createdAt: Date.now() - D * 3 },
      { id: 'p7', companyId: 'c1', title: 'Housekeeping Team Leader', department: 'Housekeeping', employmentType: 'full-time',
        description: 'Lead a room-attendant team across the Deluxe Building; manage schedules and quality inspections.',
        skills: ['Housekeeping Operations', 'Leadership', 'Scheduling', 'Teamwork'], educationLevel: 'highschool', minExperienceMonths: 12, status: 'open', createdAt: Date.now() - D * 2 },
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
      { id: 'q1', name: 'Carlos Mendoza', email: 'carlos.mendoza@roycehotel.ph', position: 'Talent Acquisition Specialist',
        companyId: 'c1', note: 'Verify with HR head Ms. Santos, local 214.', status: 'pending', requestedAt: Date.now() - D * 1 },
    ],
    emailCodes: [],
    savedJobs: [],
    // Example routing: Santos owns IT, Lopez owns Front Office. Every other
    // department is unassigned and falls back to notifying all recruiters.
    deptAssignments: [
      { companyId: 'c1', department: 'IT', userId: 'u2' },
      { companyId: 'c1', department: 'Front Office', userId: 'u7' },
    ],
  };
}

function load(): Db {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const db: Db = JSON.parse(raw);
      if (!db.emailCodes) db.emailCodes = []; // databases saved before this field existed
      if (!db.savedJobs) db.savedJobs = [];
      if (!db.deptAssignments) db.deptAssignments = []; // databases saved before department routing existed
      if (!db.users.some((u) => u.role === 'admin')) {
        // databases saved before the admin panel existed get the admin account
        db.users.push({ id: 'u6', role: 'admin', name: 'Research Team', email: 'admin@demo.ph', password: 'demo123', createdAt: Date.now() } as DemoUser);
        persist(db);
      }
      return db;
    }
  } catch { /* ignore */ }
  const db = seed();
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
const sessionId = (): string | null => {
  try { return sessionStorage.getItem(SESSION); } catch { return null; }
};
const setSession = (id: string | null): void => {
  try { id ? sessionStorage.setItem(SESSION, id) : sessionStorage.removeItem(SESSION); } catch { /* ignore */ }
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
  return c;
};

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
        return apiOk({ sent: true, simulated: true }); // same reply as success — no account enumeration, even in demo
      const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
      db.emailCodes = db.emailCodes.filter((c) => !(c.email === e && c.purpose === purpose));
      db.emailCodes.push({ email: e, purpose, code, attempts: 0, expiresAt: Date.now() + 10 * 60000 });
      persist(db);
      return apiOk({ sent: false, simulated: true, devCode: code });
    },
    registerSeeker: ({ name, email, password, code }: { name: string; email: string; password: string; code: string }) => {
      const db = load();
      const e = String(email).trim().toLowerCase();
      if (!passwordOk(password)) return apiFail(PASSWORD_HINT);
      if (db.users.some((u) => u.email.toLowerCase() === e))
        return Promise.resolve({ ok: false, exists: true, error: 'An account already uses this email. Log in instead.' } as any);
      const err = consumeCode(db, e, 'verify', code);
      if (err) return apiFail(err);
      const nm = String(name).trim();
      const em = String(email).trim().toLowerCase();
      if (nm.length < 2) return apiFail('Enter your full name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return apiFail('Enter a valid email address.');
      const user: DemoUser = { id: uid(), role: 'seeker', name: nm, email: em, password, activeResumeId: null, createdAt: Date.now() };
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
    requestRecruiterAccess: ({ name, email, position, companyId, note }: { name: string; email: string; position: string; companyId: string; note?: string }) => {
      const db = load();
      const e = String(email).trim().toLowerCase();
      if (db.users.some((u) => u.email.toLowerCase() === e)) return apiFail('An account already uses this email.');
      if (db.recruiterRequests.some((r) => r.email.toLowerCase() === e && r.status === 'pending'))
        return apiFail('A request from this email is already waiting for review.');
      db.recruiterRequests.push({ id: uid(), name, email, position, companyId, note: note || '', status: 'pending', requestedAt: Date.now() });
      persist(db);
      return apiOk({});
    },
    logout: () => { setSession(null); return apiOk({}); },
    me: () => apiOk({ user: pubUser(meRow(load())) }),
    /* Change email — same proof-of-inbox flow as registration, with the
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
    /* Demo mode stores the preference but sends nothing — there's no mail
       server behind a pure-browser demo, and the account page says so. */
    setEmailNotifications: (enabled: boolean) => {
      const db = load(); const u = meRow(db);
      if (!u) return apiFail('You are not signed in.');
      u.emailNotifications = enabled;
      persist(db);
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
      return apiOk({
        data: {
          exportedAt: new Date().toISOString(),
          account: pubUser(u),
          resumes: db.resumes.filter((r) => r.userId === u.id).map((r) => ({
            ...r, ownFile: r.ownFile ? { name: r.ownFile.name, mime: r.ownFile.mime, size: r.ownFile.size, note: 'Download the file itself from My resumes.' } : null,
          })),
          applications: db.applications.filter((a) => a.seekerId === u.id),
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
      resume = {
        ...resume,
        title: (String(resume.title ?? '').trim() || 'Untitled resume').slice(0, 120),
        template: ['chronological', 'functional', 'combination'].includes(resume.template as string)
          ? resume.template : 'chronological',
        design: ['classic', 'modern', 'minimal', 'executive', 'banner', 'split', 'bar', 'categorized']
          .includes(resume.design as string) ? resume.design : 'classic',
        education: (Array.isArray(resume.education) ? resume.education : []).slice(0, 20),
        experience: (Array.isArray(resume.experience) ? resume.experience : []).slice(0, 30),
        certifications: (Array.isArray(resume.certifications) ? resume.certifications : []).slice(0, 30),
        skills: (Array.isArray(resume.skills) ? resume.skills : []).slice(0, 100),
      } as Resume;
      const i = db.resumes.findIndex((r) => r.id === resume.id);
      try {
        if (i >= 0) {
          if (db.resumes[i].userId !== me.id) return apiFail('You can only edit your own resumes.');
          db.resumes[i] = { ...db.resumes[i], ...resume, userId: me.id, updatedAt: Date.now() };
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
        return apiFail("This resume is attached to an application, so it can't be deleted — the recruiter still needs to see exactly what you sent. Duplicate it and edit the copy instead.");
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
      // Shared constants, not re-declared literals — the duplicates here
      // meant changing the rule in engine.ts silently left demo mode behind.
      if (file.size > MAX_UPLOAD) return apiFail('That file is larger than 2 MB. Save it at a smaller size and try again.');
      if (!ALLOWED_MIME.includes(file.type)) return apiFail('Upload a PDF, Word document, or image (JPG or PNG).');
      return new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => {
          try {
            r.ownFile = { name: file.name, mime: file.type, size: file.size, uploadedAt: Date.now(), dataUrl: fr.result as string };
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
    // Open AND still accepting — a past deadline hides a posting without
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
      if (!skills.length) return apiFail("Add at least one required skill — it's half the score.");
      posting = {
        ...posting, title, department: dept, description: desc, skills,
        educationLevel: (EDU_RANK as any)[posting.educationLevel as string] !== undefined
          ? posting.educationLevel : 'bachelor',
        employmentType: ['full-time', 'part-time', 'contract', 'internship']
          .includes(posting.employmentType as string) ? posting.employmentType : 'full-time',
        minExperienceMonths: Math.max(0, Number(posting.minExperienceMonths) || 0),
      };

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
        // Always 'open', like the server — a caller must not create a
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
      // historical score from the CURRENT resume — so a seeker editing their
      // resume silently rewrote the study's own past data. `r` and `p` are
      // the resume and posting already validated above.
      const app: Application = {
        id: uid(), seekerId: me.id, resumeId, postingId, status: 'submitted',
        appliedAt: Date.now(),
        scoreSnapshot: r && p ? scoreLocal(r, p).score : null,
      };
      db.applications.push(app); persist(db);
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
    // The ranked shortlist. Every applicant is on it — nobody is filtered off.
    ranked: (postingId: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      const p = db.postings.find((x) => x.id === postingId);
      if (!p || p.companyId !== me.companyId) return apiFail('Opening not found.');
      const rows = db.applications.filter((a) => a.postingId === postingId).map((a) => {
        const resume = db.resumes.find((r) => r.id === a.resumeId)!;
        const seeker = db.users.find((u) => u.id === a.seekerId);
        return { application: a, resume, seeker: pubUser(seeker as DemoUser), ...scoreLocal(resume, p) };
      }).sort((x, y) => y.score - x.score || x.application.appliedAt - y.application.appliedAt);
      return apiOk({ posting: p, rows: rows as unknown as RankedRow[] });
    },
    setStatus: (applicationId: string, status: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      if (STATUS_ORDER.indexOf(status as any) === -1) return apiFail('Unknown status.');
      const a = db.applications.find((x) => x.id === applicationId);
      if (!a) return apiFail('Application not found.');
      const p = db.postings.find((x) => x.id === a.postingId);
      if (!p || p.companyId !== me.companyId) return apiFail('Application not found.');
      // withdrawing is the applicant's call; a recruiter can't reverse it
      if (a.status === 'withdrawn') return apiFail('This applicant withdrew their application.');
      a.status = status as any; a.updatedAt = Date.now(); (a as any).decidedBy = me.id; // a human made this call
      persist(db);
      return apiOk({ application: a });
    },
    /* The applicant's own exit — mirrors server routes/applications.ts.
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
      a.status = 'withdrawn'; a.updatedAt = Date.now();
      persist(db);
      return apiOk({ application: a });
    },
    /* Demo mode can't send the applicant a real email — the panel shows
       what WOULD be sent, clearly labelled. */
    invite: (applicationId: string, message: string) => {
      const db = load(); const me = meRow(db);
      if (!me || me.role !== 'recruiter') return apiFail('Recruiter access only.');
      const msg = String(message).trim();
      if (msg.length < 10) return apiFail('Write the applicant a short message first.');
      // The server caps this too; without the cap a 5000-character message
      // "sent" in demo and failed in api mode.
      if (msg.length > 2000) return apiFail('That message is too long — keep it under 2000 characters.');
      const a = db.applications.find((x) => x.id === applicationId);
      const p = a && db.postings.find((x) => x.id === a.postingId);
      if (!a || !p || p.companyId !== me.companyId) return apiFail('Application not found.');
      return apiOk({ sent: false, simulated: true });
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
        // row entirely — the number is then approximate, not wrong.
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
      if (!resume) return apiOk({ resume: null, strong: [], possible: [], related: [] });
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
     recruiter account with an unguessable placeholder password — the new
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
        id: uid(), role: 'recruiter', name: r.name, email: r.email,
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
          id: u.id, name: u.name, email: u.email, position: u.position || '',
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
        .map((u) => ({ id: u.id, name: u.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      assignments: db.deptAssignments
        .filter((a) => a.companyId === cid)
        .map((a) => ({ department: a.department, userId: a.userId, userName: db.users.find((u) => u.id === a.userId)?.name || '—' })),
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
    /** Demo mode can't call a real AI, so this returns a clearly-labeled
     *  simulated extraction after a short delay — enough to demonstrate the
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
          fullName: me.name,
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
    try { localStorage.removeItem(KEY); sessionStorage.removeItem(SESSION); } catch { /* ignore */ }
    return apiOk({});
  }
}
