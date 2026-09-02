/* ============================================================
   The ONE surface, TWO adapters, port of assets/api.js's design.
   DemoAdapter (localStorage) and HttpAdapter (Node API) both
   implement this interface, so every page component talks to
   ApiService without caring which mode is active.
   ============================================================ */
import {
  AdminRecruiter, AnalyzedResume, ApiResult, Application, Company, HrStats, InviteSchedule, MatchResult, Posting, RankedRow, RecommendationItem, RecruiterRequest, Resume, RoutingCompany, ScreeningNote, StatusEvent, User, RankedQuery} from './models';

export interface ApiAdapter {
  auth: {
    login(email: string, password: string): Promise<ApiResult<{ user: User }>>;
    /** Emails a 6-digit code. 'verify' = sign-up (fails with exists:true when
     *  the email already has an account); 'reset' = forgot password (never
     *  reveals whether an account exists). In demo mode, and in server dev
     *  mode without SMTP. The code comes back in devCode so the flow still
     *  works, clearly labelled as such in the UI. */
    sendCode(email: string, purpose: 'verify' | 'reset'): Promise<ApiResult<{ sent?: boolean; devCode?: string; simulated?: boolean; note?: string }>>;
    registerSeeker(d: { firstName: string; lastName: string; email: string; password: string; code: string }): Promise<ApiResult<{ user: User }>>;
    resetPassword(d: { email: string; code: string; password: string }): Promise<ApiResult<object>>;
    requestRecruiterAccess(d: { firstName: string; lastName: string; email: string; position: string; companyId: string; note?: string }): Promise<ApiResult<object>>;
    logout(): Promise<ApiResult<object>>;
    me(): Promise<ApiResult<{ user: User | null }>>;
    changePassword(current: string, next: string): Promise<ApiResult<object>>;
    /** The name on the account, what a recruiter reads beside an application.
     *  Not a credential, so no code and no password, the same as the
     *  notification toggle. Saved resumes keep their own printed name. */
    changeName(firstName: string, lastName: string): Promise<ApiResult<{ user: User }>>;
    /** Change email, proven the same way as registration: a code goes to
     *  the NEW address; the switch happens only when it checks out. */
    changeEmailStart(newEmail: string, password: string): Promise<ApiResult<{ sent?: boolean; devCode?: string; simulated?: boolean; note?: string }>>;
    changeEmailConfirm(newEmail: string, code: string): Promise<ApiResult<{ user: User }>>;
    /** Toggle application-event emails. Security codes are unaffected. */
    setEmailNotifications(enabled: boolean): Promise<ApiResult<{ user: User }>>;
    deleteAccount(password: string): Promise<ApiResult<object>>;
    exportMyData(): Promise<ApiResult<{ data: any }>>;
  };
  companies: {
    list(): Promise<ApiResult<{ companies: Company[] }>>;
    get(id: string): Promise<ApiResult<{ company: Company }>>;
    update(id: string, patch: Partial<Company>): Promise<ApiResult<object>>;
  };
  resumes: {
    mine(): Promise<ApiResult<{ resumes: Resume[] }>>;
    get(id: string): Promise<ApiResult<{ resume: Resume }>>;
    save(resume: Resume): Promise<ApiResult<{ resume: Resume }>>;
    remove(id: string): Promise<ApiResult<object>>;
    duplicate(id: string): Promise<ApiResult<{ resume: Resume }>>;
    setActive(id: string): Promise<ApiResult<object>>;
    uploadFile(resumeId: string, file: File): Promise<ApiResult<{ ownFile: Resume['ownFile'] }>>;
    removeFile(resumeId: string): Promise<ApiResult<object>>;
    fileUrl(resumeId: string): string | null;
  };
  postings: {
    open(): Promise<ApiResult<{ postings: Posting[] }>>;
    mine(): Promise<ApiResult<{ postings: Posting[] }>>;
    get(id: string): Promise<ApiResult<{ posting: Posting }>>;
    save(posting: Partial<Posting>): Promise<ApiResult<{ posting: Posting }>>;
    toggle(id: string): Promise<ApiResult<{ posting: Posting }>>;
  };
  applications: {
    apply(resumeId: string, postingId: string): Promise<ApiResult<{ application: Application }>>;
    mine(): Promise<ApiResult<{ applications: Application[] }>>;
    ranked(postingId: string, opts?: RankedQuery): Promise<ApiResult<{
      posting: Posting; rows: RankedRow[];
      /** Everyone who applied, whatever the filters say. */
      total?: number;
      /** How many survived the filters, across all pages. */
      matched?: number;
      page?: number; pages?: number; pageSize?: number;
    }>>;
    /** `reason` is optional and only meaningful on a rejection. It is recorded
     *  on the history row and read by BOTH audiences, the employer's staff in
     *  their own filing wording, the applicant in the second person. What the
     *  applicant does not learn is which staff member chose it. See
     *  routes/applications.ts for why those two gates differ. */
    setStatus(applicationId: string, status: string, reason?: string | null): Promise<ApiResult<{ application: Application }>>;

    /* SCREENING NOTES. Recruiter-only on every route: the applicant has no
       endpoint that returns them. See routes/applications.ts for why. */
    notes(applicationId: string): Promise<ApiResult<{ notes: ScreeningNote[] }>>;
    noteAdd(applicationId: string, body: string): Promise<ApiResult<{ id: string }>>;
    noteDelete(noteId: string): Promise<ApiResult<Record<string, never>>>;
    /** The applicant withdraws their own application. Seeker-only, and
     *  refused once a final decision (hired/not selected) has been made. */
    withdraw(applicationId: string): Promise<ApiResult<{ application: Application }>>;
    /** Recruiter's personal message to an applicant (interview invite).
     *  Emailed with reply-to the recruiter; simulated in demo mode. When a
     *  schedule is given, the email also carries an "Add to Google Calendar"
     *  link and an .ics attachment for the proposed interview time. */
    invite(applicationId: string, message: string, schedule?: InviteSchedule): Promise<ApiResult<{ sent?: boolean; simulated?: boolean }>>;
    /** The recorded status changes for one application, oldest first.
     *  Readable by the applicant it belongs to and by recruiters at the
     *  company that owns the posting. */
    history(applicationId: string): Promise<ApiResult<{ events: StatusEvent[] }>>;
  };
  saved: {
    /** The seeker's bookmarked openings, newest first. */
    list(): Promise<ApiResult<{ postings: Posting[] }>>;
    toggle(postingId: string): Promise<ApiResult<{ saved: boolean }>>;
  };
  metrics: {
    /** Researcher aggregates for the study, admin only, anonymous by construction. */
    summary(): Promise<ApiResult<{ metrics: any }>>;
  };
  match: {
    score(resumeId: string, postingId: string): Promise<ApiResult<MatchResult>>;
    /** openCount is every open, in-deadline posting — INCLUDING any the
     *  tiers dropped. A sub-threshold posting sharing no skill is left out
     *  of `related` on purpose, so the three arrays can all be empty while
     *  openings exist; the count is how the dashboard tells that apart from
     *  nothing having been posted. */
    recommendations(): Promise<ApiResult<{ resume: Resume | null; strong: RecommendationItem[]; possible: RecommendationItem[]; related: RecommendationItem[]; openCount?: number }>>;
  };
  stats: {
    hr(): Promise<ApiResult<{ stats: HrStats }>>;
  };
  admin: {
    /** All recruiter-access requests, pending first. Admin only. */
    requests(): Promise<ApiResult<{ requests: RecruiterRequest[] }>>;
    /** Approve = create the verified recruiter account. The person sets
     *  their own password via the forgot-password code flow. */
    approve(id: string): Promise<ApiResult<{ requests: RecruiterRequest[] }>>;
    decline(id: string): Promise<ApiResult<{ requests: RecruiterRequest[] }>>;
    recruiters(): Promise<ApiResult<{ recruiters: AdminRecruiter[] }>>;
    /** Department routing table: each company's departments, its recruiters,
     *  and who currently owns each department. Admin only. */
    deptAssignments(): Promise<ApiResult<{ companies: RoutingCompany[] }>>;
    /** Set (or, with a null userId, clear) the HR owner of one department. */
    assignDepartment(companyId: string, department: string, userId: string | null): Promise<ApiResult<{ companies: RoutingCompany[] }>>;
  };
  analyze: {
    /** Opt-in extraction of an uploaded resume file. Returns a structured
     *  resume for the user to review in the builder, never saves anything.
     *  `simulated` is true in demo mode (nothing real behind it). */
    resume(file: File): Promise<ApiResult<{ resume: AnalyzedResume; provider?: string; simulated?: boolean }>>;
    /** Which reader is configured, so the consent text can name it.
     *  'rules' , read on this server, the document never leaves it
     *  'gemini', sent to Google for reading
     *  'demo'  . Nothing is read at all; the demo build fakes it */
    reader(): Promise<ApiResult<{ reader: 'rules' | 'gemini' | 'demo'; configured: boolean }>>;
  };
  resetDemo(): Promise<ApiResult<object>>;
}
