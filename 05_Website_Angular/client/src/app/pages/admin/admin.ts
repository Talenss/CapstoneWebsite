import { DialogService } from '../../shared/dialog/dialog.service';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { AdminRecruiter, CompanyAdmin, RecruiterRequest, RoutingCompany } from '../../core/models';
import { Router } from '@angular/router';
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
  private router = inject(Router);
  session = inject(SessionService);

  isDemo = environment.mode === 'demo';
  loaded = signal(false);
  requests = signal<RecruiterRequest[]>([]);
  recruiters = signal<AdminRecruiter[]>([]);
  routing = signal<RoutingCompany[]>([]);
  admins = signal<CompanyAdmin[]>([]);
  busyAdmin = signal<string | null>(null);
  aFirst = signal(''); aLast = signal(''); aEmail = signal(''); aPos = signal('IT Manager');
  adding = signal(false);
  addErr = signal('');

  /** Whoever is signed in, by their own title: the panel is no longer only
   *  the head of recruitment's. */
  readonly myTitle = computed(() => {
    const u = this.session.user();
    const pos = u?.position || (u?.role === 'recruiter' ? 'Recruiter' : 'Admin');
    return u?.role === 'recruiter' ? `${pos} · admin access` : pos;
  });
  busyId = signal<string | null>(null);
  busyDept = signal<string | null>(null);
  errorMsg = signal('');
  toastMsg = signal<string | null>(null);

  pending = computed(() => this.requests().filter((r) => r.status === 'pending'));
  handled = computed(() => this.requests().filter((r) => r.status !== 'pending'));
  totalAssigned = computed(() => this.routing().reduce((n, c) => n + c.assignments.length, 0));

  async ngOnInit(): Promise<void> {
    const [reqRes, recRes, routeRes, admRes] = await Promise.all([
      this.api.admin.requests(),
      this.api.admin.recruiters(),
      this.api.admin.deptAssignments(),
      this.api.admin.admins(),
    ]);
    if (admRes.ok) this.admins.set(admRes.admins);
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

  val(e: Event): string { return (e.target as HTMLInputElement).value; }

  async grant(u: AdminRecruiter): Promise<void> {
    if (!(await this.dialog.confirm({
      title: `Give ${u.name} admin access?`,
      message: 'They keep their recruiter dashboard, and can also approve recruiters, route departments, edit the skill dictionary and manage who else has admin access.',
      confirmLabel: 'Give admin access',
    }))) return;
    this.errorMsg.set('');
    this.busyAdmin.set(u.id);
    const res = await this.api.admin.grantAdmin(u.id);
    this.busyAdmin.set(null);
    if (!res.ok) { this.errorMsg.set(res.error); return; }
    this.admins.set(res.admins);
    const rec = await this.api.admin.recruiters();
    if (rec.ok) this.recruiters.set(rec.recruiters);
    this.showToast(`${u.name} now has admin access.`);
  }

  async revoke(a: CompanyAdmin): Promise<void> {
    const self = a.isYou;
    const ok = await this.dialog.confirm({
      title: a.kind === 'admin' ? `Remove ${a.name}'s admin account?` : `Remove ${a.name}'s admin access?`,
      message: (a.kind === 'admin'
        ? 'This account is admin-only, so it is deleted. They will no longer be able to sign in.'
        : 'They keep their recruiter account and dashboard; only the admin panel goes.')
        + (self ? '\n\nThis is you: you will leave the admin panel straight away.' : ''),
      confirmLabel: a.kind === 'admin' ? 'Remove account' : 'Remove access', danger: true,
    });
    if (!ok) return;
    this.errorMsg.set('');
    this.busyAdmin.set(a.id);
    const res = await this.api.admin.revokeAdmin(a.id);
    this.busyAdmin.set(null);
    if (!res.ok) { this.errorMsg.set(res.error); return; }
    if (res.removedSelf) {
      // Their own access is gone: back to wherever they now belong.
      const me = await this.session.refresh();
      await this.router.navigateByUrl(me ? this.session.homeFor(me) : '/auth');
      return;
    }
    this.admins.set(res.admins);
    const rec = await this.api.admin.recruiters();
    if (rec.ok) this.recruiters.set(rec.recruiters);
    this.showToast(a.kind === 'admin' ? `${a.name}'s admin account was removed.` : `${a.name} no longer has admin access.`);
  }

  async addAdmin(e: Event): Promise<void> {
    e.preventDefault();
    this.addErr.set('');
    this.adding.set(true);
    const res = await this.api.admin.addAdmin({
      firstName: this.aFirst(), lastName: this.aLast(), email: this.aEmail(), position: this.aPos(),
    });
    this.adding.set(false);
    if (!res.ok) { this.addErr.set(res.error); return; }
    this.admins.set(res.admins);
    const name = `${this.aFirst().trim()} ${this.aLast().trim()}`;
    this.aFirst.set(''); this.aLast.set(''); this.aEmail.set(''); this.aPos.set('IT Manager');
    this.showToast(`${name} can now use the admin panel. They set their password with "Forgot password".`);
  }

  day(t: number | null): string {
    return t ? new Date(t).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 4200);
  }
}
