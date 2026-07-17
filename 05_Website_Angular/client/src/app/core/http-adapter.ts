/* ============================================================
   HTTP ADAPTER — identical surface to DemoAdapter, backed by the
   Node/Express API (server/src/routes/*.ts) over MySQL. Port of
   the `php` object in 04_Website/app/assets/api.js, adapted to
   the Node route scheme: POST /api/<router>/<action> instead of
   PHP's ?action= query string.
   ============================================================ */
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiAdapter } from './adapter';
import { AnalyzedResume, Application, ApiResult, Company, HrStats, MatchResult, Posting, RankedRow, RecommendationItem, Resume, User } from './models';
import { MAX_UPLOAD, ALLOWED_MIME } from './engine';

export class HttpAdapter implements ApiAdapter {
  constructor(private http: HttpClient, private apiBase: string) {}

  private async call<T extends object>(endpoint: string, action: string, payload?: any): Promise<ApiResult<T>> {
    try {
      return await firstValueFrom(
        this.http.post<ApiResult<T>>(`${this.apiBase}/${endpoint}/${action}`, payload ?? {}, { withCredentials: true }),
      );
    } catch (e: any) {
      const serverMsg = e?.error?.error;
      return { ok: false, error: serverMsg || "Can't reach the server. Check that the API is running." } as ApiResult<T>;
    }
  }

  auth = {
    login: (email: string, password: string) => this.call<{ user: User }>('auth', 'login', { email, password }),
    sendCode: (email: string, purpose: 'verify' | 'reset') =>
      this.call<{ sent?: boolean; devCode?: string; simulated?: boolean; note?: string }>('auth', 'send-code', { email, purpose }),
    registerSeeker: (d: any) => this.call<{ user: User }>('auth', 'register', d),
    resetPassword: (d: { email: string; code: string; password: string }) => this.call<object>('auth', 'reset-password', d),
    requestRecruiterAccess: (d: any) => this.call<object>('auth', 'request-access', d),
    logout: () => this.call<object>('auth', 'logout'),
    me: () => this.call<{ user: User | null }>('auth', 'me'),
    changePassword: (current: string, next: string) => this.call<object>('auth', 'change-password', { current, next }),
    deleteAccount: (password: string) => this.call<object>('auth', 'delete-account', { password }),
    exportMyData: () => this.call<{ data: any }>('auth', 'export'),
  };

  companies = {
    list: () => this.call<{ companies: Company[] }>('companies', 'list'),
    get: (id: string) => this.call<{ company: Company }>('companies', 'get', { id }),
    update: (id: string, patch: Partial<Company>) => this.call('companies', 'update', { id, ...patch }),
  };

  resumes = {
    mine: () => this.call<{ resumes: Resume[] }>('resumes', 'list'),
    get: (id: string) => this.call<{ resume: Resume }>('resumes', 'get', { id }),
    save: (r: Resume) => this.call<{ resume: Resume }>('resumes', 'save', { resume: r }),
    remove: (id: string) => this.call<object>('resumes', 'delete', { id }),
    duplicate: (id: string) => this.call<{ resume: Resume }>('resumes', 'duplicate', { id }),
    setActive: (id: string) => this.call<object>('resumes', 'set-active', { id }),
    uploadFile: async (resumeId: string, file: File): Promise<ApiResult<{ ownFile: Resume['ownFile'] }>> => {
      if (file.size > MAX_UPLOAD) return { ok: false, error: 'That file is larger than 2 MB. Save it at a smaller size and try again.' };
      if (!ALLOWED_MIME.includes(file.type)) return { ok: false, error: 'Upload a PDF, Word document, or image (JPG or PNG).' };
      const fd = new FormData();
      fd.append('resume_id', resumeId); fd.append('file', file);
      try {
        return await firstValueFrom(
          this.http.post<ApiResult<{ ownFile: Resume['ownFile'] }>>(`${this.apiBase}/resumes/upload`, fd, { withCredentials: true }),
        );
      } catch (e: any) {
        return { ok: false, error: e?.error?.error || 'Upload failed. Check that the server is running.' };
      }
    },
    removeFile: (id: string) => this.call<object>('resumes', 'remove-file', { id }),
    // served through an auth-checked endpoint — applicant files are never a guessable public URL
    fileUrl: (id: string) => `${this.apiBase}/file?resume_id=${encodeURIComponent(id)}`,
  };

  postings = {
    open: () => this.call<{ postings: Posting[] }>('postings', 'list'),
    mine: () => this.call<{ postings: Posting[] }>('postings', 'mine'),
    get: (id: string) => this.call<{ posting: Posting }>('postings', 'get', { id }),
    save: (p: Partial<Posting>) => this.call<{ posting: Posting }>('postings', 'save', { posting: p }),
    toggle: (id: string) => this.call<{ posting: Posting }>('postings', 'toggle', { id }),
  };

  applications = {
    apply: (resumeId: string, postingId: string) => this.call<{ application: Application }>('applications', 'apply', { resumeId, postingId }),
    mine: () => this.call<{ applications: Application[] }>('applications', 'mine'),
    ranked: (postingId: string) => this.call<{ posting: Posting; rows: RankedRow[] }>('applications', 'ranked', { postingId }),
    setStatus: (id: string, status: string) => this.call<{ application: Application }>('applications', 'set-status', { id, status }),
  };

  match = {
    score: (resumeId: string, postingId: string) => this.call<MatchResult>('match', 'score', { resumeId, postingId }),
    recommendations: () => this.call<{ resume: Resume | null; strong: RecommendationItem[]; possible: RecommendationItem[]; related: RecommendationItem[] }>('match', 'recommendations'),
  };

  stats = { hr: () => this.call<{ stats: HrStats }>('stats', 'hr') };

  analyze = {
    resume: async (file: File): Promise<ApiResult<{ resume: AnalyzedResume; provider?: string; simulated?: boolean }>> => {
      if (file.size > MAX_UPLOAD) return { ok: false, error: 'That file is larger than 2 MB. Save it at a smaller size and try again.' };
      if (!ALLOWED_MIME.includes(file.type)) return { ok: false, error: 'Upload a PDF, Word document, or image (JPG or PNG).' };
      const fd = new FormData();
      fd.append('file', file);
      try {
        return await firstValueFrom(
          this.http.post<ApiResult<{ resume: AnalyzedResume; provider?: string }>>(`${this.apiBase}/analyze/resume`, fd, { withCredentials: true }),
        );
      } catch (e: any) {
        return { ok: false, error: e?.error?.error || 'The analysis failed. Check that the server is running and try again.' };
      }
    },
  };

  resetDemo(): Promise<ApiResult<object>> {
    return Promise.resolve({ ok: false, error: 'Not available in server mode.' });
  }
}
