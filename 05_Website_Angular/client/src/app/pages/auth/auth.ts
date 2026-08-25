import { Component, OnDestroy, OnInit, WritableSignal, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { OtpInput } from '../../shared/otp-input/otp-input';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { Company } from '../../core/models';
import { passwordOk, PASSWORD_HINT } from '../../core/engine';
import { reportInvalidFields } from '../../shared/invalid-fields';
import { PasswordRevealDirective } from '../../shared/password-reveal.directive';
import { environment } from '../../../environments/environment';

type Tab = 'login' | 'reg';
type Role = 'seeker' | 'recruiter';
type RegMessage = { type: 'error' | 'ok'; text: string; companyName?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_SECONDS = 60;

/** Port of the PHP auth.html — the log in / create account page.
 *  Combines a login form and a role-aware register form (seeker vs.
 *  recruiter/HR access request) in one tabbed panel, mirroring the
 *  original's tab + hash + role-toggle script 1:1.
 *
 *  Seeker registration is a two-step flow: the form first, then a 6-digit
 *  code emailed to the address (simulated on-screen in demo mode) — so an
 *  account only exists once its email is proven real. The login panel
 *  doubles as the forgot-password flow, same code mechanism. */
@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [FormsModule, OtpInput, RouterLink, Header, PasswordRevealDirective],
  templateUrl: './auth.html',
  styleUrl: './auth.css',
})
export class Auth implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private session = inject(SessionService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  activeTab = signal<Tab>('login');
  role = signal<Role>('seeker');
  companies = signal<Company[]>([]);
  readonly passwordHint = PASSWORD_HINT;

  /** Working logins are printed on this page for graders and reviewers.
   *  They belong ONLY in the browser-only demo build, where the accounts
   *  are seeded fakes living in the visitor's own localStorage and there
   *  is no server behind them. In api mode the same page sits in front of
   *  a real database, and a list of credentials on an unauthenticated
   *  screen is a standing risk from the moment that build goes up.
   *
   *  The research team's admin login is gone from both modes regardless:
   *  it reaches every applicant record and the study's own metrics, so it
   *  does not belong on a public screen even in a demo. */
  readonly showDemoAccounts = environment.mode === 'demo';

  // ---- login form state ----
  loginEmail = '';
  loginPassword = '';
  loginEmailInvalid = signal(false);
  loginPasswordInvalid = signal(false);
  loginError = signal('');
  loginNotice = signal(''); // green banner, e.g. after a password reset
  loginBusy = signal(false);

  // ---- forgot password (lives inside the login panel) ----
  forgotOpen = signal(false);
  fpStep = signal<'email' | 'code'>('email');
  fpEmail = '';
  fpCode = '';
  fpPassword = '';
  fpEmailInvalid = signal(false);
  fpCodeInvalid = signal(false);
  fpPasswordInvalid = signal(false);
  fpError = signal('');
  fpBusy = signal(false);
  fpDevCode = signal<string | null>(null);
  fpDevNote = signal<'demo' | 'debug' | null>(null);
  fpResendLeft = signal(0);

  // ---- register form state ----
  regFirstName = '';
  regLastName = '';
  regEmail = '';
  regPassword = '';
  regCompanyId = '';
  regPosition = '';
  regNote = '';
  regFirstNameInvalid = signal(false);
  regLastNameInvalid = signal(false);
  regEmailInvalid = signal(false);
  regPasswordInvalid = signal(false);
  regCompanyInvalid = signal(false);
  regPositionInvalid = signal(false);
  regMessage = signal<RegMessage | null>(null);
  regBusy = signal(false);

  // ---- register: email verification step ----
  regStep = signal<'form' | 'code'>('form');
  regCode = '';
  regCodeInvalid = signal(false);
  regExists = signal(false); // "this email already has an account, log in instead?"
  regDevCode = signal<string | null>(null);
  regDevNote = signal<'demo' | 'debug' | null>(null);
  regResendLeft = signal(0);

  private timers: ReturnType<typeof setInterval>[] = [];

  regBtnLabel = computed(() => (this.role() === 'recruiter' ? 'Send access request' : 'Continue, verify my email'));
  regHeading = computed(() => {
    if (this.role() === 'recruiter') return 'Request recruiter access';
    return this.regStep() === 'code' ? 'Confirm your email' : 'Create your free account';
  });
  regSub = computed(() => {
    if (this.role() === 'recruiter') return 'We verify every request with the partner company before activating an account.';
    return this.regStep() === 'code'
      ? 'One last step, prove the email is really yours.'
      : 'Pick your role, the form follows.';
  });

  constructor() {
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((fragment) => this.applyFragment(fragment));
  }

  ngOnInit(): void {
    this.checkExistingSession();
    this.loadCompanies();
  }

  ngOnDestroy(): void {
    this.timers.forEach((t) => clearInterval(t));
  }

  private async checkExistingSession(): Promise<void> {
    const res = await this.api.auth.me();
    if (res.ok && res.user) {
      const next = this.route.snapshot.queryParamMap.get('next');
      this.router.navigateByUrl(next || this.session.homeFor(res.user), { replaceUrl: true });
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
    this.regExists.set(false);
  }

  private emailValid(v: string): boolean {
    return EMAIL_RE.test(String(v).trim());
  }

  /** Re-tests every field this page can mark, as the user types.
   *
   *  It only ever CLEARS a mark: each entry below is `alreadyFlagged && still
   *  wrong`, so a field that has not failed a submit yet can never light up
   *  while someone is halfway through typing an address. Before this, the
   *  flags were set on submit and cleared nowhere, so the form went on saying
   *  an email was invalid after it had been corrected — and then accepted the
   *  submission anyway. The screen contradicting the behaviour, at the first
   *  moment a new user is deciding whether the thing works.
   *
   *  aria-invalid is reconciled in the same pass. Dropping the red border and
   *  leaving the attribute behind would fix this only for people who can see
   *  the border. `focus: false` because moving the keyboard on a keystroke
   *  would be its own bug. */
  recheck(): void {
    const hr = this.role() === 'recruiter';
    const states = [
      { id: 'le', invalid: this.loginEmailInvalid() && !this.emailValid(this.loginEmail) },
      { id: 'lp', invalid: this.loginPasswordInvalid() && this.loginPassword.length === 0 },
      { id: 'rfn', invalid: this.regFirstNameInvalid() && this.regFirstName.trim().length < 2 },
      { id: 'rln', invalid: this.regLastNameInvalid() && this.regLastName.trim().length > 60 },
      { id: 're', invalid: this.regEmailInvalid() && !this.emailValid(this.regEmail) },
      { id: 'rp', invalid: this.regPasswordInvalid() && !hr && !passwordOk(this.regPassword) },
      { id: 'rc', invalid: this.regCompanyInvalid() && hr && !this.regCompanyId },
      { id: 'rpos', invalid: this.regPositionInvalid() && hr && this.regPosition.trim().length < 2 },
      { id: 'rcode', invalid: this.regCodeInvalid() && !/^\d{6}$/.test(this.regCode.trim()) },
      { id: 'fpe', invalid: this.fpEmailInvalid() && !this.emailValid(this.fpEmail) },
      { id: 'fpc', invalid: this.fpCodeInvalid() && !/^\d{6}$/.test(this.fpCode.trim()) },
      { id: 'fpp', invalid: this.fpPasswordInvalid() && !passwordOk(this.fpPassword) },
    ];
    this.loginEmailInvalid.set(states[0].invalid);
    this.loginPasswordInvalid.set(states[1].invalid);
    this.regFirstNameInvalid.set(states[2].invalid);
    this.regLastNameInvalid.set(states[3].invalid);
    this.regEmailInvalid.set(states[4].invalid);
    this.regPasswordInvalid.set(states[5].invalid);
    this.regCompanyInvalid.set(states[6].invalid);
    this.regPositionInvalid.set(states[7].invalid);
    this.regCodeInvalid.set(states[8].invalid);
    this.fpEmailInvalid.set(states[9].invalid);
    this.fpCodeInvalid.set(states[10].invalid);
    this.fpPasswordInvalid.set(states[11].invalid);
    reportInvalidFields(states, { focus: false });
  }

  /** 60-second countdown before "Resend code" becomes clickable again. */
  private startCooldown(sig: WritableSignal<number>): void {
    sig.set(RESEND_SECONDS);
    const t = setInterval(() => {
      const left = sig() - 1;
      sig.set(left);
      if (left <= 0) clearInterval(t);
    }, 1000);
    this.timers.push(t);
  }

  // ============================== LOG IN ==============================

  async onLogin(e: Event): Promise<void> {
    e.preventDefault();
    this.loginError.set('');
    this.loginNotice.set('');

    const emailOk = this.emailValid(this.loginEmail);
    this.loginEmailInvalid.set(!emailOk);
    const passOk = this.loginPassword.length > 0;
    this.loginPasswordInvalid.set(!passOk);
    if (!reportInvalidFields([
      { id: 'le', invalid: !emailOk },
      { id: 'lp', invalid: !passOk },
    ])) return;

    this.loginBusy.set(true);
    const res = await this.api.auth.login(this.loginEmail.trim(), this.loginPassword);
    this.loginBusy.set(false);
    if (!res.ok) {
      this.loginError.set(res.error);
      return;
    }

    const next = this.route.snapshot.queryParamMap.get('next');
    this.router.navigateByUrl(next || this.session.homeFor(res.user));
  }

  // ========================= FORGOT PASSWORD =========================

  toggleForgot(open: boolean): void {
    this.forgotOpen.set(open);
    this.fpStep.set('email');
    this.fpEmail = open ? this.loginEmail : '';
    this.fpCode = '';
    this.fpPassword = '';
    this.fpError.set('');
    this.fpDevCode.set(null);
    this.fpDevNote.set(null);
    this.fpEmailInvalid.set(false);
    this.fpCodeInvalid.set(false);
    this.fpPasswordInvalid.set(false);
    this.loginError.set('');
    this.loginNotice.set('');
  }

  async onForgotSend(e: Event): Promise<void> {
    e.preventDefault();
    this.fpError.set('');
    const emailOk = this.emailValid(this.fpEmail);
    this.fpEmailInvalid.set(!emailOk);
    if (!reportInvalidFields([{ id: 'fpe', invalid: !emailOk }])) return;

    this.fpBusy.set(true);
    const res = await this.api.auth.sendCode(this.fpEmail.trim(), 'reset');
    this.fpBusy.set(false);
    if (!res.ok) {
      this.fpError.set(res.error);
      return;
    }
    this.fpDevCode.set(res.devCode ?? null);
    this.fpDevNote.set(res.devCode ? (res.simulated ? 'demo' : 'debug') : null);
    this.fpStep.set('code');
    this.startCooldown(this.fpResendLeft);
  }

  async resendForgot(): Promise<void> {
    if (this.fpResendLeft() > 0 || this.fpBusy()) return;
    this.fpError.set('');
    this.fpBusy.set(true);
    const res = await this.api.auth.sendCode(this.fpEmail.trim(), 'reset');
    this.fpBusy.set(false);
    if (!res.ok) {
      this.fpError.set(res.error);
      return;
    }
    this.fpDevCode.set(res.devCode ?? null);
    this.fpDevNote.set(res.devCode ? (res.simulated ? 'demo' : 'debug') : null);
    this.startCooldown(this.fpResendLeft);
  }

  async onForgotReset(e: Event): Promise<void> {
    e.preventDefault();
    this.fpError.set('');
    const codeOk = /^\d{6}$/.test(this.fpCode.trim());
    this.fpCodeInvalid.set(!codeOk);
    const passOk = passwordOk(this.fpPassword);
    this.fpPasswordInvalid.set(!passOk);
    if (!reportInvalidFields([
      { id: 'fpc', invalid: !codeOk },
      { id: 'fpp', invalid: !passOk },
    ])) return;

    this.fpBusy.set(true);
    const res = await this.api.auth.resetPassword({ email: this.fpEmail.trim(), code: this.fpCode.trim(), password: this.fpPassword });
    this.fpBusy.set(false);
    if (!res.ok) {
      this.fpError.set(res.error);
      return;
    }
    this.loginEmail = this.fpEmail.trim();
    this.loginPassword = '';
    this.toggleForgot(false);
    this.loginNotice.set('Password updated. Log in with your new password.');
  }

  // ====================== CREATE ACCOUNT (SEEKER) ======================

  async onRegister(e: Event): Promise<void> {
    e.preventDefault();
    this.regMessage.set(null);
    this.regExists.set(false);
    const hr = this.role() === 'recruiter';

    /* Only the first name is required. A person with one name is not an
        invalid person, and a sign-up form is the wrong place to rule on it. */
    const nameOk = this.regFirstName.trim().length >= 2 && this.regFirstName.trim().length <= 60;
    this.regFirstNameInvalid.set(!nameOk);
    const lastOk = this.regLastName.trim().length <= 60;
    this.regLastNameInvalid.set(!lastOk);
    const emailOk = this.emailValid(this.regEmail);
    this.regEmailInvalid.set(!emailOk);

    let passOk = true;
    if (!hr) {
      passOk = passwordOk(this.regPassword);
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

    // Listed in the order they appear, and only the ones this role actually
    // renders — the password field and the company/position pair are on
    // opposite sides of an @if, and focusing a field that is not on screen
    // would be worse than not moving at all.
    if (!reportInvalidFields([
      { id: 'rfn', invalid: !nameOk },
      { id: 'rln', invalid: !lastOk },
      { id: 're', invalid: !emailOk },
      ...(hr
        ? [{ id: 'rc', invalid: !companyOk }, { id: 'rpos', invalid: !posOk }]
        : [{ id: 'rp', invalid: !passOk }]),
    ])) return;

    this.regBusy.set(true);
    if (!hr) {
      // Step 1 of 2: send the verification code. The account is only
      // created after the code checks out in onVerifyRegister().
      const res = await this.api.auth.sendCode(this.regEmail.trim(), 'verify');
      this.regBusy.set(false);
      if (!res.ok) {
        if (res.exists) {
          this.regExists.set(true);
        } else {
          this.regMessage.set({ type: 'error', text: res.error });
        }
        return;
      }
      this.regCode = '';
      this.regCodeInvalid.set(false);
      this.regDevCode.set(res.devCode ?? null);
      this.regDevNote.set(res.devCode ? (res.simulated ? 'demo' : 'debug') : null);
      this.regStep.set('code');
      this.startCooldown(this.regResendLeft);
    } else {
      const companyName = this.companies().find((c) => c.id === this.regCompanyId)?.name ?? '';
      const res = await this.api.auth.requestRecruiterAccess({
        firstName: this.regFirstName.trim(),
        lastName: this.regLastName.trim(),
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

  async onVerifyRegister(e: Event): Promise<void> {
    e.preventDefault();
    this.regMessage.set(null);
    const codeOk = /^\d{6}$/.test(this.regCode.trim());
    this.regCodeInvalid.set(!codeOk);
    if (!reportInvalidFields([{ id: 'rcode', invalid: !codeOk }])) return;

    this.regBusy.set(true);
    const res = await this.api.auth.registerSeeker({
      firstName: this.regFirstName.trim(),
      lastName: this.regLastName.trim(),
      email: this.regEmail.trim(),
      password: this.regPassword,
      code: this.regCode.trim(),
    });
    this.regBusy.set(false);
    if (!res.ok) {
      if (res.exists) {
        this.regStep.set('form');
        this.regExists.set(true);
      } else {
        this.regMessage.set({ type: 'error', text: res.error });
      }
      return;
    }
    this.router.navigate(['/resume-builder'], { queryParams: { welcome: 1 } });
  }

  async resendRegister(): Promise<void> {
    if (this.regResendLeft() > 0 || this.regBusy()) return;
    this.regMessage.set(null);
    this.regBusy.set(true);
    const res = await this.api.auth.sendCode(this.regEmail.trim(), 'verify');
    this.regBusy.set(false);
    if (!res.ok) {
      this.regMessage.set({ type: 'error', text: res.error });
      return;
    }
    this.regDevCode.set(res.devCode ?? null);
    this.regDevNote.set(res.devCode ? (res.simulated ? 'demo' : 'debug') : null);
    this.startCooldown(this.regResendLeft);
  }

  backToRegForm(): void {
    this.regStep.set('form');
    this.regCode = '';
    this.regCodeInvalid.set(false);
    this.regMessage.set(null);
  }

  /** "This email already has an account" → jump to the login tab, prefilled. */
  useLoginInstead(): void {
    this.loginEmail = this.regEmail.trim();
    this.loginPassword = '';
    this.loginError.set('');
    this.loginNotice.set('This email already has an account, welcome back. Log in below.');
    this.regExists.set(false);
    this.activeTab.set('login');
  }

  dismissExists(): void {
    this.regExists.set(false);
    this.regEmail = '';
  }

  private resetRegisterForm(): void {
    this.regFirstName = '';
    this.regLastName = '';
    this.regEmail = '';
    this.regPassword = '';
    this.regCompanyId = '';
    this.regPosition = '';
    this.regNote = '';
    this.regFirstNameInvalid.set(false);
    this.regLastNameInvalid.set(false);
    this.regEmailInvalid.set(false);
    this.regPasswordInvalid.set(false);
    this.regCompanyInvalid.set(false);
    this.regPositionInvalid.set(false);
    this.regStep.set('form');
    this.regCode = '';
    this.regExists.set(false);
    this.regDevCode.set(null);
    this.regDevNote.set(null);
    this.role.set('seeker');
  }
}
