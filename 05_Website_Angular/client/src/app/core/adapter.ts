/* ============================================================
   The ONE surface, TWO adapters — port of assets/api.js's design.
   DemoAdapter (localStorage) and HttpAdapter (Node API) both
   implement this interface, so every page component talks to
   ApiService without caring which mode is active.
   ============================================================ */
import {
  AnalyzedResume, ApiResult, Application, Company, HrStats, MatchResult, Posting, RankedRow, RecommendationItem, Resume, User,
} from './models';

export interface ApiAdapter {
  auth: {
    login(email: string, password: string): Promise<ApiResult<{ user: User }>>;
    registerSeeker(d: { name: string; email: string; password: string }): Promise<ApiResult<{ user: User }>>;
    requestRecruiterAccess(d: { name: string; email: string; position: string; companyId: string; note?: string }): Promise<ApiResult<object>>;
    logout(): Promise<ApiResult<object>>;
    me(): Promise<ApiResult<{ user: User | null }>>;
    changePassword(current: string, next: string): Promise<ApiResult<object>>;
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
    ranked(postingId: string): Promise<ApiResult<{ posting: Posting; rows: RankedRow[] }>>;
    setStatus(applicationId: string, status: string): Promise<ApiResult<{ application: Application }>>;
  };
  match: {
    score(resumeId: string, postingId: string): Promise<ApiResult<MatchResult>>;
    recommendations(): Promise<ApiResult<{ resume: Resume | null; strong: RecommendationItem[]; possible: RecommendationItem[]; related: RecommendationItem[] }>>;
  };
  stats: {
    hr(): Promise<ApiResult<{ stats: HrStats }>>;
  };
  analyze: {
    /** Opt-in AI extraction of an uploaded resume file. Returns a structured
     *  resume for the user to review in the builder — never saves anything.
     *  `simulated` is true in demo mode (no real AI behind it). */
    resume(file: File): Promise<ApiResult<{ resume: AnalyzedResume; provider?: string; simulated?: boolean }>>;
  };
  resetDemo(): Promise<ApiResult<object>>;
}
