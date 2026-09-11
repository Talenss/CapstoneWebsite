import { Component, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { ApplicationAnswer, Company, MatchResult, Posting, Resume } from '../../core/models';
import { EDU_LABELS, WEIGHTS, experienceLabel, missingHint, scoreLocal, tierColor, tierLabel, tierOf, weightsFor, normSkill} from '../../core/engine';
import { FocusTrapDirective } from '../../shared/focus-trap.directive';
import { ApplyQuestions } from '../../shared/apply-questions/apply-questions';
import { Seo } from '../../core/seo';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { SelectOption } from '../../shared/select-options';

interface BrowseRow {
  posting: Posting;
  company: Company | null;
  s: MatchResult | null;
  applied: boolean;
}
type SortKey = 'score' | 'new' | 'az';

/** Port of the PHP browse.html — the only fully public page in the
 *  seeker cluster. Works differently for guests (no scoring, CTA to sign
 *  up), seekers (scored locally against their active resume, can apply),
 *  and recruiters (can browse but not apply). Role is read once from
 *  SessionService, which also drives the shared header's nav. */
@Component({
  selector: 'app-browse',
  standalone: true,
  imports: [RouterLink, Header, Footer, FocusTrapDirective, ApplyQuestions, ...HlmSelectImports],
  templateUrl: './browse.html',
  styleUrl: './browse.css',
})
export class Browse implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private seo = inject(Seo);
  session = inject(SessionService);

  readonly EDU_LABELS = EDU_LABELS;
  readonly WEIGHTS = WEIGHTS;
  readonly experienceLabel = experienceLabel;
  readonly tierColor = tierColor;
  readonly tierLabel = tierLabel;

  /** The weights an opening is scored with, for the GUEST view — a visitor
   *  with no resume has no MatchResult to read them off, and the openings
   *  each carry their own now, so a fixed 50/25/25 here would misdescribe
   *  any opening the recruiter tuned. */
  postingWeights = (p: Posting) => weightsFor(p);

  loaded = signal(false);
  postings = signal<Posting[]>([]);
  resume = signal<Resume | null>(null);

  /** How many requirements are unmet and of what kind, never which ones.
   *  See missingHint() in core/engine.ts for why this is not a list. */
  readonly missingHint = missingHint;
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
    this.showToast(res.saved ? 'Saved, find it on your dashboard.' : 'Removed from saved openings.');
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

  /** How the openings on this page fall out against the active resume. Counted
   *  from every opening, not the filtered view, so the picture does not change
   *  as the user narrows the list. */
  readonly spread = computed(() => {
    const rows = this.rows().filter((r) => r.s);
    return {
      total: rows.length,
      strong: rows.filter((r) => r.s!.tier === 'strong').length,
      possible: rows.filter((r) => r.s!.tier === 'possible').length,
      related: rows.filter((r) => r.s!.tier === 'related').length,
      best: rows.reduce((a, r) => Math.max(a, r.s!.score), 0),
    };
  });

  /** The skills these openings ask for that the resume does not carry, most
   *  asked-for first. This is the most useful thing the page knows and it was
   *  not being said anywhere: a job seeker can see that four of seven openings
   *  want a skill they have not listed, which is an afternoon's work away. */
  readonly gaps = computed(() => {
    const resume = this.resume();
    if (!resume) return [];
    const have = new Set(resume.skills.map(normSkill));
    const wanted = new Map<string, { label: string; n: number }>();
    for (const p of this.postings()) {
      for (const raw of p.skills) {
        const k = normSkill(raw);
        if (have.has(k)) continue;
        const cur = wanted.get(k);
        if (cur) cur.n += 1;
        else wanted.set(k, { label: raw, n: 1 });
      }
    }
    return [...wanted.values()].sort((a, b) => b.n - a.n).slice(0, 6);
  });

  /** A department is its own label; only the empty value needs words. */
  readonly deptLabel = (v: string): string => v || 'All departments';
  /** "Best match first" only exists once there is a resume to match against. */
  readonly sortOptions = computed<readonly SelectOption[]>(() => [
    ...(this.resume() ? [{ v: 'score', label: 'Best match first' }] : []),
    { v: 'new', label: 'Newest first' },
    { v: 'az', label: 'A to Z' },
  ]);
  readonly sortLabel = (v: string): string =>
    this.sortOptions().find((o) => o.v === v)?.label ?? String(v ?? '');

  sub = computed(() => {
    if (!this.loaded()) return "Every posting here is a real vacancy, posted by Clark Outsourcing's own HR staff.";
    const n = this.postings().length;
    return `${n} open position${n === 1 ? '' : 's'} at Clark Outsourcing, every one posted by their own HR staff.`;
  });

  /** The order actually applied, which is not always the one the signal holds.
   *  'score' is the default, and a guest has no resume to score against, so it
   *  falls back to newest-first for them.
   *
   *  The SELECT binds to this rather than to the raw signal, and that is the
   *  whole point of it existing: "Best match first" is only rendered as an
   *  option when there is a resume, so binding the control to a signal holding
   *  'score' left a guest looking at an empty dropdown. The list underneath was
   *  ordered correctly the entire time — only the control that names the order
   *  was blank, which is the worse failure of the two, because it reads as a
   *  broken page rather than as a default. */
  effectiveSort = computed<SortKey>(() =>
    this.resume() ? this.sort() : this.sort() === 'score' ? 'new' : this.sort());

  filteredRows = computed<BrowseRow[]>(() => {
    const q = this.query().trim().toLowerCase();
    const d = this.dept();
    const sort = this.effectiveSort();

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

    /* Structured data for the openings. Emitted only when the build says
       these are real vacancies — see Seo.jobPostings, which explains why
       that is off by default. */
    this.seo.jobPostings(this.postings().map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      employmentType: p.employmentType,
      skills: p.skills,
      postedAt: p.createdAt,
      validThrough: p.deadline ?? null,
      companyName: p.company?.name ?? '',
      companyWebsite: p.company?.website ?? null,
      location: p.company?.location ?? null,
    })));
  }

  /* A crawler that follows a link away from /browse must not carry this
     page's job listings onto the next one. */
  ngOnDestroy(): void {
    this.seo.jsonLd('ld-jobs', null);
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
    // Topmost first. The question dialog opens over the detail one, so a
    // single Escape that closed the sheet underneath would leave the
    // questions floating over nothing.
    if (this.asking()) { this.cancelAsk(); return; }
    if (this.current()) this.closeDetail();
  }

  /* THE OPENING'S SCREENING QUESTIONS, when it has any. Set to the row being
     applied to, which is what puts the question dialog on screen; an opening
     that asks nothing goes straight through as it always did. */
  asking = signal<BrowseRow | null>(null);

  applyNow(row: BrowseRow): void {
    const r = this.resume();
    if (!r || !r.id) return;
    if ((row.posting.questions ?? []).length) { this.asking.set(row); return; }
    void this.send(row, []);
  }

  cancelAsk(): void { this.asking.set(null); }

  onAnswered(answers: ApplicationAnswer[]): void {
    const row = this.asking();
    if (row) void this.send(row, answers);
  }

  private async send(row: BrowseRow, answers: ApplicationAnswer[]): Promise<void> {
    const r = this.resume();
    if (!r || !r.id) return;
    this.applying.set(true);
    const res = await this.api.applications.apply(r.id, row.posting.id, answers);
    this.applying.set(false);
    if (!res.ok) {
      // The dialog stays open on a failure. Closing it would throw away
      // answers the applicant has just typed, and a rejected application is
      // exactly when they need them back.
      this.showToast(res.error);
      return;
    }
    this.asking.set(null);
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
