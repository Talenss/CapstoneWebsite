import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { ApiAdapter } from './adapter';
import { DemoAdapter } from './demo-adapter';
import { HttpAdapter } from './http-adapter';

/** ONE surface, TWO adapters — see core/adapter.ts. Every page component
 *  injects ApiService and calls e.g. api.auth.me(), api.resumes.mine(),
 *  never caring whether CONFIG.mode is 'demo' or 'api'. */
@Injectable({ providedIn: 'root' })
export class ApiService implements ApiAdapter {
  private impl: ApiAdapter = environment.mode === 'api'
    ? new HttpAdapter(inject(HttpClient), environment.apiBase)
    : new DemoAdapter();

  get auth() { return this.impl.auth; }
  get companies() { return this.impl.companies; }
  get resumes() { return this.impl.resumes; }
  get postings() { return this.impl.postings; }
  get applications() { return this.impl.applications; }
  get match() { return this.impl.match; }
  get stats() { return this.impl.stats; }
  get analyze() { return this.impl.analyze; }
  get admin() { return this.impl.admin; }
  resetDemo() { return this.impl.resetDemo(); }
}
