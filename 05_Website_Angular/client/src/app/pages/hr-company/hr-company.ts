import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';

/** Port of 04_Website/app/hr-company.html — edit the recruiter's own
 *  company profile, with a live preview of what applicants will see. */
@Component({
  selector: 'app-hr-company',
  standalone: true,
  // See the note in hr-posting: without FormsModule, (ngSubmit) is a
  // custom event nothing dispatches, and Save profile performs a native
  // form submit that reloads the page and discards every edit.
  imports: [FormsModule, RouterLink, Header, Footer],
  templateUrl: './hr-company.html',
  styleUrl: './hr-company.css',
})
export class HrCompany {
  private api = inject(ApiService);
  private session = inject(SessionService);

  companyId = signal<string | null>(null);
  loadError = signal<string | null>(null);
  loading = signal(true);

  name = signal('');
  industry = signal('');
  website = signal('');
  location = signal('');
  about = signal('');

  saving = signal(false);
  msg = signal<string | null>(null);
  toastMsg = signal<string | null>(null);

  previewMeta = computed(() => [this.industry(), this.location()].filter(Boolean).join(' · '));

  constructor() {
    this.load();
  }

  private async load(): Promise<void> {
    const user = this.session.user();
    if (!user?.companyId) { this.loadError.set('No company is linked to this account.'); this.loading.set(false); return; }
    const res = await this.api.companies.get(user.companyId);
    this.loading.set(false);
    if (!res.ok) { this.loadError.set(res.error); return; }
    const c = res.company;
    this.companyId.set(c.id);
    this.name.set(c.name || '');
    this.industry.set(c.industry || '');
    this.website.set(c.website || '');
    this.location.set(c.location || '');
    this.about.set(c.about || '');
  }

  setName(e: Event): void { this.name.set((e.target as HTMLInputElement).value); }
  setIndustry(e: Event): void { this.industry.set((e.target as HTMLInputElement).value); }
  setWebsite(e: Event): void { this.website.set((e.target as HTMLInputElement).value); }
  setLocation(e: Event): void { this.location.set((e.target as HTMLInputElement).value); }
  setAbout(e: Event): void { this.about.set((e.target as HTMLTextAreaElement).value); }

  async submit(): Promise<void> {
    const id = this.companyId();
    if (!id) return;
    this.saving.set(true);
    const res = await this.api.companies.update(id, {
      name: this.name().trim(),
      industry: this.industry().trim(),
      website: this.website().trim(),
      location: this.location().trim(),
      about: this.about().trim(),
    });
    this.saving.set(false);
    if (!res.ok) { this.msg.set(res.error); return; }
    this.msg.set(null);
    this.showToast('Company profile saved.');
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
