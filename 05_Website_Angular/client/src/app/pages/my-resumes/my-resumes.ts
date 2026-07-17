import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { ApiService } from '../../core/api.service';
import { Resume, Template } from '../../core/models';

/** Port of 04_Website/app/my-resumes.html — the seeker's resume library.
 *  Grid of resume cards with make-active / edit / PDF / duplicate / delete
 *  actions, plus a "+ New resume" tile. */
@Component({
  selector: 'app-my-resumes',
  standalone: true,
  imports: [RouterLink, Header],
  templateUrl: './my-resumes.html',
  styleUrl: './my-resumes.css',
})
export class MyResumes implements OnInit {
  private api = inject(ApiService);

  loaded = signal(false);
  resumes = signal<Resume[]>([]);
  activeId = signal<string | null>(null);
  usedCounts = signal<Record<string, number>>({});
  toastMsg = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await this.render();
  }

  private async render(): Promise<void> {
    const [res, meRes, appsRes] = await Promise.all([
      this.api.resumes.mine(),
      this.api.auth.me(),
      this.api.applications.mine(),
    ]);
    this.resumes.set(res.ok ? res.resumes : []);
    this.activeId.set(meRes.ok ? (meRes.user?.activeResumeId ?? null) : null);

    const used: Record<string, number> = {};
    if (appsRes.ok) {
      for (const a of appsRes.applications) used[a.resumeId] = (used[a.resumeId] || 0) + 1;
    }
    this.usedCounts.set(used);
    this.loaded.set(true);
  }

  monthsFor(r: Resume): number {
    return (r.experience || []).reduce((t, e) => t + (Number(e.months) || 0), 0);
  }

  templateLabel(t: Template): string {
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  day(ts: number | undefined): string {
    return ts ? new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }

  async makeActive(r: Resume): Promise<void> {
    if (!r.id) return;
    await this.api.resumes.setActive(r.id);
    await this.render();
    this.showToast(`"${r.title}" is now your active resume.`);
  }

  async duplicateResume(r: Resume): Promise<void> {
    if (!r.id) return;
    const d = await this.api.resumes.duplicate(r.id);
    if (!d.ok) {
      this.showToast(d.error);
      return;
    }
    await this.render();
    this.showToast('Copied. The uploaded file isn’t carried over — attach it again if you want it.');
  }

  async deleteResume(r: Resume): Promise<void> {
    if (!r.id) return;
    if (!confirm(`Delete "${r.title}"? This can’t be undone.`)) return;
    const d = await this.api.resumes.remove(r.id);
    if (!d.ok) {
      this.showToast(d.error);
      return;
    }
    await this.render();
    this.showToast('Resume deleted.');
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3400);
  }
}
