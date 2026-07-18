import { Component, computed, inject, signal } from '@angular/core';
import { Header } from '../../layout/header/header';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { environment } from '../../../environments/environment';

/** Port of 04_Website/app/account.html — shared by both seeker and
 *  recruiter accounts (the route is guarded with no specific role).
 *  Details, password change, RA 10173 data export, and account deletion. */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [RouterLink, Header],
  templateUrl: './account.html',
  styleUrl: './account.css',
})
export class Account {
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
    const newOk = newInput.value.length >= 6;
    const repOk = repInput.value === newInput.value && repInput.value.length > 0;
    this.curInvalid.set(!curOk);
    this.newInvalid.set(!newOk);
    this.repInvalid.set(!repOk);
    if (!curOk || !newOk || !repOk) return;

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
    a.download = 'resumematch-ph-my-data.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.showToast('Your data was downloaded.');
  }

  async onDeleteSubmit(e: Event, delPwInput: HTMLInputElement): Promise<void> {
    e.preventDefault();
    this.msg.set(null);
    if (!delPwInput.value) {
      this.delInvalid.set(true);
      return;
    }
    this.delInvalid.set(false);

    if (!confirm('Delete your account and everything in it? This cannot be undone.')) return;

    this.delSaving.set(true);
    const res = await this.api.auth.deleteAccount(delPwInput.value);
    this.delSaving.set(false);

    if (!res.ok) {
      this.msg.set(res.error);
      return;
    }
    alert('Your account and all of its data have been deleted.');
    location.href = '/';
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3200);
  }
}
