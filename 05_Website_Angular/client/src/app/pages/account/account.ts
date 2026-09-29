import { DialogService } from '../../shared/dialog/dialog.service';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OtpInput } from '../../shared/otp-input/otp-input';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { environment } from '../../../environments/environment';
import { passwordOk, PASSWORD_HINT } from '../../core/engine';
import { reportInvalidFields } from '../../shared/invalid-fields';
import { PasswordRevealDirective } from '../../shared/password-reveal.directive';

/** Port of the PHP account.html — shared by both seeker and
 *  recruiter accounts (the route is guarded with no specific role).
 *  Details, password change, RA 10173 data export, and account deletion. */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [FormsModule, OtpInput, RouterLink, Header, Footer, PasswordRevealDirective],
  templateUrl: './account.html',
  styleUrl: './account.css',
})
export class Account {
  private dialog = inject(DialogService);
  private api = inject(ApiService);
  session = inject(SessionService);

  headerVariant = computed<'seeker' | 'recruiter' | 'admin'>(() => {
    const role = this.session.user()?.role;
    return role === 'seeker' ? 'seeker' : role === 'admin' ? 'admin' : 'recruiter';
  });

  memberSince = computed(() => {
    const u = this.session.user();
    return u?.createdAt
      ? new Date(u.createdAt).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })
      : '—';
  });

  msg = signal<string | null>(null);
  toastMsg = signal<string | null>(null);
  readonly passwordHint = PASSWORD_HINT;

  /* ---- change the name on the account ----
     A typo made at sign-up used to be permanent, and this name is what a
     recruiter reads beside an application. No password and no code: it
     proves nothing, and demanding one would be theatre. */
  nameOpen = signal(false);
  cnFirst = '';
  cnLast = '';
  cnError = signal('');
  cnBusy = signal(false);

  openChangeName(): void {
    this.cnFirst = this.session.user()?.firstName ?? '';
    this.cnLast = this.session.user()?.lastName ?? '';
    this.cnError.set('');
    this.nameOpen.set(true);
  }

  cancelChangeName(): void {
    this.nameOpen.set(false);
  }

  async onChangeName(e: Event): Promise<void> {
    e.preventDefault();
    this.cnError.set('');
    const first = this.cnFirst.trim().replace(/\s+/g, ' ');
    const last = this.cnLast.trim().replace(/\s+/g, ' ');
    if (first.length < 2) {
      this.cnError.set('Enter your first name.');
      return;
    }
    if (first.length > 60 || last.length > 60) {
      this.cnError.set('Each name can be at most 60 characters.');
      return;
    }
    const u = this.session.user();
    if (first === (u?.firstName ?? '') && last === (u?.lastName ?? '')) {
      this.nameOpen.set(false);
      return;
    }
    this.cnBusy.set(true);
    const res = await this.api.auth.changeName(first, last);
    this.cnBusy.set(false);
    if (!res.ok) {
      this.cnError.set(res.error);
      return;
    }
    this.session.user.set(res.user);
    this.nameOpen.set(false);
    this.showToast('Name updated.');
  }

  // ---- change email (code-verified, like registration) ----
  emailStep = signal<'closed' | 'form' | 'code'>('closed');
  ceNewEmail = '';
  cePassword = '';
  ceCode = '';
  ceError = signal('');
  ceBusy = signal(false);
  ceDevCode = signal<string | null>(null);

  openChangeEmail(): void {
    this.emailStep.set('form');
    this.ceNewEmail = '';
    this.cePassword = '';
    this.ceCode = '';
    this.ceError.set('');
    this.ceDevCode.set(null);
  }

  cancelChangeEmail(): void {
    this.emailStep.set('closed');
  }

  async onChangeEmailStart(e: Event): Promise<void> {
    e.preventDefault();
    this.ceError.set('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.ceNewEmail.trim())) {
      this.ceError.set('Enter a valid email address.');
      return;
    }
    this.ceBusy.set(true);
    const res = await this.api.auth.changeEmailStart(this.ceNewEmail.trim(), this.cePassword);
    this.ceBusy.set(false);
    if (!res.ok) {
      this.ceError.set(res.error);
      return;
    }
    this.ceDevCode.set(res.devCode ?? null);
    this.emailStep.set('code');
  }

  async onChangeEmailConfirm(e: Event): Promise<void> {
    e.preventDefault();
    this.ceError.set('');
    if (!/^\d{6}$/.test(this.ceCode.trim())) {
      this.ceError.set('Enter the 6-digit code from the email.');
      return;
    }
    this.ceBusy.set(true);
    const res = await this.api.auth.changeEmailConfirm(this.ceNewEmail.trim(), this.ceCode.trim());
    this.ceBusy.set(false);
    if (!res.ok) {
      this.ceError.set(res.error);
      return;
    }
    this.session.user.set(res.user);
    this.emailStep.set('closed');
    this.showToast('Email address updated.');
  }

  // ---- email notifications toggle ----
  isDemo = environment.mode === 'demo';
  notifySaving = signal(false);
  notifyOn = computed(() => this.session.user()?.emailNotifications !== false);

  async onToggleNotify(e: Event): Promise<void> {
    const box = e.target as HTMLInputElement;
    const enabled = box.checked;
    this.notifySaving.set(true);
    const res = await this.api.auth.setEmailNotifications(enabled);
    this.notifySaving.set(false);
    if (!res.ok) {
      box.checked = !enabled;
      this.msg.set(res.error);
      return;
    }
    this.session.user.set(res.user);
    this.showToast(enabled ? 'Email updates are on.' : 'Email updates are off.');
  }

  curInvalid = signal(false);
  newInvalid = signal(false);
  repInvalid = signal(false);
  delInvalid = signal(false);

  pwSaving = signal(false);
  delSaving = signal(false);

  async onPwSubmit(
    e: Event,
    curInput: HTMLInputElement,
    newInput: HTMLInputElement,
    repInput: HTMLInputElement,
    form: HTMLFormElement,
  ): Promise<void> {
    e.preventDefault();
    this.msg.set(null);

    const curOk = curInput.value.length > 0;
    const newOk = passwordOk(newInput.value);
    const repOk = repInput.value === newInput.value && repInput.value.length > 0;
    this.curInvalid.set(!curOk);
    this.newInvalid.set(!newOk);
    this.repInvalid.set(!repOk);
    if (!reportInvalidFields([
      { id: 'cur', invalid: !curOk },
      { id: 'new', invalid: !newOk },
      { id: 'rep', invalid: !repOk },
    ])) return;

    this.pwSaving.set(true);
    const res = await this.api.auth.changePassword(curInput.value, newInput.value);
    this.pwSaving.set(false);

    if (!res.ok) {
      this.msg.set(res.error);
      return;
    }
    form.reset();
    this.curInvalid.set(false);
    this.newInvalid.set(false);
    this.repInvalid.set(false);
    this.showToast('Password changed.');
  }

  async downloadData(): Promise<void> {
    const res = await this.api.auth.exportMyData();
    if (!res.ok) {
      this.showToast(res.error);
      return;
    }
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'linaw-ph-my-data.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.showToast('Your data was downloaded.');
  }

  async onDeleteSubmit(e: Event, delPwInput: HTMLInputElement): Promise<void> {
    e.preventDefault();
    this.msg.set(null);
    this.delInvalid.set(!delPwInput.value);
    if (!reportInvalidFields([{ id: 'delPw', invalid: !delPwInput.value }])) return;

    if (!(await this.dialog.confirm({
      title: 'Delete your account?',
      message: 'Your account and everything in it, every resume, file and application, will be deleted. This cannot be undone.',
      confirmLabel: 'Delete my account', cancelLabel: 'Keep my account', danger: true,
    }))) return;

    this.delSaving.set(true);
    const res = await this.api.auth.deleteAccount(delPwInput.value);
    this.delSaving.set(false);

    if (!res.ok) {
      this.msg.set(res.error);
      return;
    }
    await this.dialog.notice({
      title: 'Your account has been deleted',
      message: 'Your account and all of its data are gone. You will be taken to the home page.',
    });
    location.href = '/';
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3200);
  }
}
