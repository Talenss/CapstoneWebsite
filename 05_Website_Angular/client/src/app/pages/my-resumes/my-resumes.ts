import { Component, OnInit, inject, signal, computed} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { Resume, ResumeDesign, Template } from '../../core/models';
import { MAX_RESUMES } from '../../core/engine';

/** Port of the PHP my-resumes.html — the seeker's resume library.
 *  Grid of resume cards with make-active / edit / PDF / duplicate / delete
 *  actions, plus a "+ New resume" tile. */
@Component({
  selector: 'app-my-resumes',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './my-resumes.html',
  styleUrl: './my-resumes.css',
})
export class MyResumes implements OnInit {
  private api = inject(ApiService);

  loaded = signal(false);
  resumes = signal<Resume[]>([]);
  readonly MAX_RESUMES = MAX_RESUMES;
  /** At the limit, every way of adding one says so up front, rather than
   *  letting someone build a whole resume the server will then refuse. */
  atLimit = computed(() => this.resumes().length >= MAX_RESUMES);
  activeId = signal<string | null>(null);
  usedCounts = signal<Record<string, number>>({});

  /** Totals for the rail, from the data the page already holds. */
  readonly usedTotal = computed(() =>
    Object.values(this.usedCounts()).reduce((a, n) => a + n, 0));
  readonly activeTitle = computed(() =>
    this.resumes().find((r) => r.id === this.activeId())?.title ?? null);
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

  /** The design's on-screen name. Every design id is now the lowercase form
   *  of the name the builder's picker shows, so capitalising it is enough and
   *  there is no special case left to keep in step. */
  designLabel(d: ResumeDesign | undefined): string {
    if (!d) return 'Classic';
    return d.charAt(0).toUpperCase() + d.slice(1);
  }

  /** Which optional sections this resume carries, for the card's summary.
   *  Named rather than counted — "Projects · Languages" tells the applicant
   *  which of their two drafts is the fuller one; "+2 sections" does not. */
  extraSections(r: Resume): string {
    return [
      r.projects?.length ? 'Projects' : '',
      r.languages?.length ? 'Languages' : '',
      r.references?.length ? 'References' : '',
      r.certifications?.length ? 'Certifications' : '',
    ].filter(Boolean).join(' · ');
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

  /** The card puts the title in its heading and every other action beside
   *  it, but there was no way to change it here: renaming meant opening the
   *  builder, finding the Details step, editing the field, saving, and
   *  coming back. The name is how an applicant tells "IT — fresh graduate"
   *  from "Front office", so it belongs where the resumes are listed. */
  async renameResume(r: Resume): Promise<void> {
    if (!r.id) return;
    const answer = prompt('What should this resume be called?', r.title);
    if (answer === null) return;                       // Cancel
    const title = answer.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!title) { this.showToast('A resume needs a name.'); return; }
    if (title === r.title) return;

    /* Re-read the whole record before writing it back. The card needs only a
       summary, and if the list payload ever leaves a section out, saving the
       card's copy would quietly delete it. A rename must never cost data. */
    const cur = await this.api.resumes.get(r.id);
    if (!cur.ok) { this.showToast(cur.error); return; }

    const saved = await this.api.resumes.save({ ...cur.resume, title });
    if (!saved.ok) { this.showToast(saved.error); return; }
    await this.render();
    this.showToast(`Renamed to "${title}".`);
  }

  async duplicateResume(r: Resume): Promise<void> {
    if (!r.id) return;
    const d = await this.api.resumes.duplicate(r.id);
    if (!d.ok) {
      this.showToast(d.error);
      return;
    }
    await this.render();
    this.showToast('Copied. The uploaded file isn’t carried over, attach it again if you want it.');
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
