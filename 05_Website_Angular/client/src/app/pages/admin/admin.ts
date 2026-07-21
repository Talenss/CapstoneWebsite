import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { AdminRecruiter, RecruiterRequest } from '../../core/models';
import { environment } from '../../../environments/environment';

/** The research-team panel behind "recruiter accounts are provisioned,
 *  not self-served": review the requests the auth page's recruiter form
 *  creates, approve (which creates the verified account) or decline.
 *  The new recruiter sets their own password via the forgot-password
 *  code flow — the approval email walks them through it. */
@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [Header, Footer],
  templateUrl: './admin.html',
  styleUrl: './admin.css',
})
export class Admin implements OnInit {
  private api = inject(ApiService);
  session = inject(SessionService);

  isDemo = environment.mode === 'demo';
  loaded = signal(false);
  requests = signal<RecruiterRequest[]>([]);
  recruiters = signal<AdminRecruiter[]>([]);
  busyId = signal<string | null>(null);
  errorMsg = signal('');
  toastMsg = signal<string | null>(null);

  pending = computed(() => this.requests().filter((r) => r.status === 'pending'));
  handled = computed(() => this.requests().filter((r) => r.status !== 'pending'));

  async ngOnInit(): Promise<void> {
    const [reqRes, recRes] = await Promise.all([this.api.admin.requests(), this.api.admin.recruiters()]);
    if (reqRes.ok) this.requests.set(reqRes.requests);
    if (recRes.ok) this.recruiters.set(recRes.recruiters);
    this.loaded.set(true);
  }

  async approve(r: RecruiterRequest): Promise<void> {
    this.errorMsg.set('');
    this.busyId.set(r.id);
    const res = await this.api.admin.approve(r.id);
    this.busyId.set(null);
    if (!res.ok) {
      this.errorMsg.set(res.error);
      return;
    }
    this.requests.set(res.requests);
    const recRes = await this.api.admin.recruiters();
    if (recRes.ok) this.recruiters.set(recRes.recruiters);
    this.showToast(`${r.name}'s recruiter account is active. They set their password with "Forgot password".`);
  }

  async decline(r: RecruiterRequest): Promise<void> {
    if (!confirm(`Decline ${r.name}'s request? They'll be told the request couldn't be verified.`)) return;
    this.errorMsg.set('');
    this.busyId.set(r.id);
    const res = await this.api.admin.decline(r.id);
    this.busyId.set(null);
    if (!res.ok) {
      this.errorMsg.set(res.error);
      return;
    }
    this.requests.set(res.requests);
    this.showToast(`Request from ${r.name} declined.`);
  }

  day(t: number | null): string {
    return t ? new Date(t).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 4200);
  }
}
