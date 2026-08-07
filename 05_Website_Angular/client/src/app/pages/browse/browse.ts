import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { Company, MatchResult, Posting, Resume } from '../../core/models';
import { EDU_LABELS, WEIGHTS, scoreLocal, tierColor, tierLabel, tierOf } from '../../core/engine';
import { FocusTrapDirective } from '../../shared/focus-trap.directive';

interface BrowseRow {
  posting: Posting;
  company: Company | null;
  s: MatchResult | null;
  applied: boolean;
}
type SortKey = 'score' | 'new' | 'az';

/** Port of 04_Website/app/browse.html — the only fully public page in the
 *  seeker cluster. Works differently for guests (no scoring, CTA to sign
 *  up), seekers (scored locally against their active resume, can apply),
 *  and recruiters (can browse but not apply). Role is read once from
 *  SessionService, which also drives the shared header's nav. */
@Component({
  selector: 'app-browse',
  standalone: true,
  imports: [RouterLink, Header, Footer, FocusTrapDirective],
  templateUrl: './browse.html',
  styleUrl: './browse.css',
})
export class Browse implements OnInit {
  private api = inject(ApiService);
  session = inject(SessionService);

  readonly EDU_LABELS = EDU_LABELS;
  readonly WEIGHTS = WEIGHTS;
  readonly tierColor = tierColor;
  readonly tierLabel = tierLabel;

  loaded = signal(false);
  postings = signal<Posting[]>([]);
  resume = signal<Resume | null>(null);
  appliedTo = signal<string[]>([]);

  query = signal('');
  dept = signal('');
  sort = signal<SortKey>('score');

  current = signal<BrowseRow | null>(null);
  applying = signal(false);
  toastMsg = signal<string | null>(null);
  savedIds = signal<string[]>([]);

  isSaved(postingId: string): boolean {
    return this.savedIds().includes(postingId);
  }

  async toggleSave(row: BrowseRow): Promise<void> {
    const res = await this.api.saved.toggle(row.posting.id);
    if (!res.ok) {
      this.showToast(res.error);
      return;
    }
    this.savedIds.update((ids) =>
      res.saved ? [...ids, row.posting.id] : ids.filter((id) => id !== row.posting.id));
    this.showToast(res.saved ? 'Saved — find it on your dashboard.' : 'Removed from saved openings.');
  }

  deadlineLabel(p: Posting): string | null {
    if (!p.deadline) return null;
    return 'Apply by ' + new Date(p.deadline + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  }

  isSeeker = computed(() => this.session.user()?.role === 'seeker');
  headerVariant = computed<'guest' | 'seeker' | 'recruiter'>(() => {
    const u = this.session.user();
    if (!u) return 'guest';
    return u.role === 'seeker' ? 'seeker' : 'recruiter';
  });

  rows = computed<BrowseRow[]>(() => {
    const resume = this.resume();
    const applied = new Set(this.appliedTo());
    return this.postings().map((p) => ({
      posting: p,
      company: p.company ?? null,
      s: resume ? scoreLocal(resume, p) : null,
      applied: applied.has(p.id),
    }));
  });

  depts = computed(() => Array.from(new Set(this.postings().map((p) => p.department))).sort());

  sub = computed(() => {
    if (!this.loaded()) return "Every posting here is a real vacancy, posted by Clark Outsourcing's own HR staff.";
    const n = this.postings().length;
    return `${n} open position${n === 1 ? '' : 's'} at Clark Outsourcing — every one posted by their own HR staff.`;
  });

  filteredRows = computed<BrowseRow[]>(() => {
    const q = this.query().trim().toLowerCase();
    const d = this.dept();
    const hasResume = !!this.resume();
    const sort: SortKey = hasResume ? this.sort() : this.sort() === 'score' ? 'new' : this.sort();

    let out = this.rows().filter((r) => {
      if (d && r.posting.department !== d) return false;
      if (!q) return true;
      return (r.posting.title + ' ' + r.posting.department + ' ' + r.posting.description + ' ' + r.posting.skills.join(' '))
        .toLowerCase()
        .includes(q);
    });

    out = out.slice().sort((a, b) =>
      sort === 'az'
        ? a.posting.title.localeCompare(b.posting.title)
        : sort === 'new'
          ? b.posting.createdAt - a.posting.createdAt
          : (b.s ? b.s.score : 0) - (a.s ? a.s.score : 0),
    );

    return out;
  });

  async ngOnInit(): Promise<void> {
    const user = await this.session.ensure();

    if (user && user.role === 'seeker') {
      const [rRes, aRes, sRes] = await Promise.all([this.api.resumes.mine(), this.api.applications.mine(), this.api.saved.list()]);
      const list = rRes.ok ? rRes.resumes : [];
      const active = list.find((r) => r.id === user.activeResumeId) || list[0] || null;
      this.resume.set(active);
      this.appliedTo.set(aRes.ok ? aRes.applications.map((a) => a.postingId) : []);
      this.savedIds.set(sRes.ok ? sRes.postings.map((p) => p.id) : []);
    }

    const pRes = await this.api.postings.open();
    this.postings.set(pRes.ok ? pRes.postings : []);
    this.loaded.set(true);
  }

  onQueryInput(e: Event): void {
    this.query.set((e.target as HTMLInputElement).value);
  }
  onDeptChange(e: Event): void {
    this.dept.set((e.target as HTMLSelectElement).value);
  }
  onSortChange(e: Event): void {
    this.sort.set((e.target as HTMLSelectElement).value as SortKey);
  }

  tierBadgeClass(score: number): string {
    const t = tierOf(score);
    return t === 'strong' ? 'green' : t === 'possible' ? 'amber' : 'slate';
  }

  openDetail(row: BrowseRow): void {
    this.current.set(row);
  }
  closeDetail(): void {
    this.current.set(null);
  }
  onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.closeDetail();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.current()) this.closeDetail();
  }

  async applyNow(row: BrowseRow): Promise<void> {
    const r = this.resume();
    if (!r || !r.id) return;
    this.applying.set(true);
    const res = await this.api.applications.apply(r.id, row.posting.id);
    this.applying.set(false);
    if (!res.ok) {
      this.showToast(res.error);
      return;
    }
    this.appliedTo.update((list) => [...list, row.posting.id]);
    const title = row.posting.title;
    this.closeDetail();
    this.showToast(`Applied to ${title}. Follow it on your dashboard.`);
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
