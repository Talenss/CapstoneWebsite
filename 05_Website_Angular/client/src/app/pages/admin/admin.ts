import { DialogService } from '../../shared/dialog/dialog.service';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { AdminRecruiter, RecruiterRequest, RoutingCompany } from '../../core/models';
import { environment } from '../../../environments/environment';
import { HlmSelectImports } from '@spartan-ng/helm/select';

/** The research-team panel behind "recruiter accounts are provisioned,
 *  not self-served": review the requests the auth page's recruiter form
 *  creates, approve (which creates the verified account) or decline.
 *  The new recruiter sets their own password via the forgot-password
 *  code flow — the approval email walks them through it. */
@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [Header, Footer, ...HlmSelectImports],
  templateUrl: './admin.html',
  styleUrl: './admin.css',
})
export class Admin implements OnInit {
  private dialog = inject(DialogService);
  private api = inject(ApiService);
  session = inject(SessionService);

  isDemo = environment.mode === 'demo';
  loaded = signal(false);
  requests = signal<RecruiterRequest[]>([]);
  recruiters = signal<AdminRecruiter[]>([]);
  routing = signal<RoutingCompany[]>([]);
  busyId = signal<string | null>(null);
  busyDept = signal<string | null>(null);
  errorMsg = signal('');
  toastMsg = signal<string | null>(null);

  pending = computed(() => this.requests().filter((r) => r.status === 'pending'));
  handled = computed(() => this.requests().filter((r) => r.status !== 'pending'));
  totalAssigned = computed(() => this.routing().reduce((n, c) => n + c.assignments.length, 0));

  async ngOnInit(): Promise<void> {
    const [reqRes, recRes, routeRes] = await Promise.all([
      this.api.admin.requests(),
      this.api.admin.recruiters(),
      this.api.admin.deptAssignments(),
    ]);
    if (reqRes.ok) this.requests.set(reqRes.requests);
    if (recRes.ok) this.recruiters.set(recRes.recruiters);
    if (routeRes.ok) this.routing.set(routeRes.companies);
    this.loaded.set(true);
  }

  /** The recruiter currently owning this department (or '' = all recruiters). */
  ownerOf(co: RoutingCompany, dept: string): string {
    return co.assignments.find((a) => a.department.trim().toLowerCase() === dept.trim().toLowerCase())?.userId ?? '';
  }

  /** Each company has its own recruiters, so the code-to-name lookup is
   *  per company rather than one shared map. */
  ownerLabel(co: RoutingCompany): (id: string) => string {
    return (id) => co.recruiters.find((r) => r.id === id)?.name ?? 'All recruiters (unassigned)';
  }

  async assign(co: RoutingCompany, dept: string, value: string): Promise<void> {
    const userId = value || null;
    this.errorMsg.set('');
    this.busyDept.set(co.id + '::' + dept);
    const res = await this.api.admin.assignDepartment(co.id, dept, userId);
    this.busyDept.set(null);
    if (!res.ok) {
      this.errorMsg.set(res.error);
      return;
    }
    this.routing.set(res.companies);
    const who = userId ? (co.recruiters.find((r) => r.id === userId)?.name ?? 'that recruiter') : 'all recruiters';
    this.showToast(`${dept} applications now notify ${who}.`);
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
    const [recRes, routeRes] = await Promise.all([this.api.admin.recruiters(), this.api.admin.deptAssignments()]);
    if (recRes.ok) this.recruiters.set(recRes.recruiters);
    if (routeRes.ok) this.routing.set(routeRes.companies);
    this.showToast(`${r.name}'s recruiter account is active. They set their password with "Forgot password".`);
  }

  async decline(r: RecruiterRequest): Promise<void> {
    if (!(await this.dialog.confirm({
      title: `Decline ${r.name}'s request?`,
      message: "They'll be told the request couldn't be verified.",
      confirmLabel: 'Decline request', danger: true,
    }))) return;
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
