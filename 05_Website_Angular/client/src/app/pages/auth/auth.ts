import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { ApiService } from '../../core/api.service';
import { Company } from '../../core/models';

type Tab = 'login' | 'reg';
type Role = 'seeker' | 'recruiter';
type RegMessage = { type: 'error' | 'ok'; text: string; companyName?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Port of 04_Website/app/auth.html — the log in / create account page.
 *  Combines a login form and a role-aware register form (seeker vs.
 *  recruiter/HR access request) in one tabbed panel, mirroring the
 *  original's tab + hash + role-toggle script 1:1. */
@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [FormsModule, RouterLink, Header],
  templateUrl: './auth.html',
  styleUrl: './auth.css',
})
export class Auth implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  activeTab = signal<Tab>('login');
  role = signal<Role>('seeker');
  companies = signal<Company[]>([]);

  // ---- login form state ----
  loginEmail = '';
  loginPassword = '';
  loginEmailInvalid = signal(false);
  loginPasswordInvalid = signal(false);
  loginError = signal('');
  loginBusy = signal(false);

  // ---- register form state ----
  regName = '';
  regEmail = '';
  regPassword = '';
  regCompanyId = '';
  regPosition = '';
  regNote = '';
  regNameInvalid = signal(false);
  regEmailInvalid = signal(false);
  regPasswordInvalid = signal(false);
  regCompanyInvalid = signal(false);
  regPositionInvalid = signal(false);
  regMessage = signal<RegMessage | null>(null);
  regBusy = signal(false);

  regBtnLabel = computed(() => (this.role() === 'recruiter' ? 'Send access request' : 'Create job seeker account'));
  regHeading = computed(() => (this.role() === 'recruiter' ? 'Request recruiter access' : 'Create your free account'));
  regSub = computed(() =>
    this.role() === 'recruiter'
      ? 'We verify every request with the partner company before activating an account.'
      : 'Pick your role — the form follows.',
  );

  constructor() {
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((fragment) => this.applyFragment(fragment));
  }

  ngOnInit(): void {
    this.checkExistingSession();
    this.loadCompanies();
  }

  private async checkExistingSession(): Promise<void> {
    const res = await this.api.auth.me();
    if (res.ok && res.user) {
      const next = this.route.snapshot.queryParamMap.get('next');
      this.router.navigateByUrl(next || (res.user.role === 'seeker' ? '/seeker-dashboard' : '/hr-dashboard'));
    }
  }

  private async loadCompanies(): Promise<void> {
    const res = await this.api.companies.list();
    if (res.ok) this.companies.set(res.companies);
  }

  private applyFragment(fragment: string | null): void {
    if (!fragment || !fragment.startsWith('register')) return;
    this.activeTab.set('reg');
    if (fragment === 'register-hr') this.role.set('recruiter');
  }

  showTab(tab: Tab): void {
    this.activeTab.set(tab);
  }

  setRole(role: Role): void {
    this.role.set(role);
  }

  private emailValid(v: string): boolean {
    return EMAIL_RE.test(String(v).trim());
  }

  async onLogin(e: Event): Promise<void> {
    e.preventDefault();
    this.loginError.set('');

    const emailOk = this.emailValid(this.loginEmail);
    this.loginEmailInvalid.set(!emailOk);
    const passOk = this.loginPassword.length > 0;
    this.loginPasswordInvalid.set(!passOk);
    if (!emailOk || !passOk) return;

    this.loginBusy.set(true);
    const res = await this.api.auth.login(this.loginEmail.trim(), this.loginPassword);
    this.loginBusy.set(false);
    if (!res.ok) {
      this.loginError.set(res.error);
      return;
    }

    const next = this.route.snapshot.queryParamMap.get('next');
    this.router.navigateByUrl(next || (res.user.role === 'seeker' ? '/seeker-dashboard' : '/hr-dashboard'));
  }

  async onRegister(e: Event): Promise<void> {
    e.preventDefault();
    this.regMessage.set(null);
    const hr = this.role() === 'recruiter';

    const nameOk = this.regName.trim().length >= 2;
    this.regNameInvalid.set(!nameOk);
    const emailOk = this.emailValid(this.regEmail);
    this.regEmailInvalid.set(!emailOk);

    let passOk = true;
    if (!hr) {
      passOk = this.regPassword.length >= 6;
      this.regPasswordInvalid.set(!passOk);
    } else {
      this.regPasswordInvalid.set(false);
    }

    let companyOk = true;
    let posOk = true;
    if (hr) {
      companyOk = !!this.regCompanyId;
      this.regCompanyInvalid.set(!companyOk);
      posOk = this.regPosition.trim().length >= 2;
      this.regPositionInvalid.set(!posOk);
    } else {
      this.regCompanyInvalid.set(false);
      this.regPositionInvalid.set(false);
    }

    if (!(nameOk && emailOk && passOk && companyOk && posOk)) return;

    this.regBusy.set(true);
    if (!hr) {
      const res = await this.api.auth.registerSeeker({
        name: this.regName.trim(),
        email: this.regEmail.trim(),
        password: this.regPassword,
      });
      this.regBusy.set(false);
      if (!res.ok) {
        this.regMessage.set({ type: 'error', text: res.error });
        return;
      }
      this.router.navigate(['/resume-builder'], { queryParams: { welcome: 1 } });
    } else {
      const companyName = this.companies().find((c) => c.id === this.regCompanyId)?.name ?? '';
      const res = await this.api.auth.requestRecruiterAccess({
        name: this.regName.trim(),
        email: this.regEmail.trim(),
        position: this.regPosition.trim(),
        companyId: this.regCompanyId,
        note: this.regNote.trim(),
      });
      this.regBusy.set(false);
      if (!res.ok) {
        this.regMessage.set({ type: 'error', text: res.error });
        return;
      }
      this.regMessage.set({ type: 'ok', text: '', companyName });
      this.resetRegisterForm();
    }
  }

  private resetRegisterForm(): void {
    this.regName = '';
    this.regEmail = '';
    this.regPassword = '';
    this.regCompanyId = '';
    this.regPosition = '';
    this.regNote = '';
    this.regNameInvalid.set(false);
    this.regEmailInvalid.set(false);
    this.regPasswordInvalid.set(false);
    this.regCompanyInvalid.set(false);
    this.regPositionInvalid.set(false);
    this.role.set('seeker');
  }
}
