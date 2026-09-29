import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { TourService } from '../../shared/tour/tour.service';
import { AppStatus, HrStats, Posting } from '../../core/models';
import { STATUS_LABELS, STATUS_ORDER } from '../../core/engine';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { labelFor, SelectOption } from '../../shared/select-options';

/** Port of the PHP hr-dashboard.html — the recruiter's home: a stat
 *  tally, the five-stage pipeline funnel, and the list of their own
 *  openings with review/edit/close-reopen actions. */
@Component({
  selector: 'app-hr-dashboard',
  standalone: true,
  imports: [RouterLink, Header, Footer, ...HlmSelectImports],
  templateUrl: './hr-dashboard.html',
  styleUrl: './hr-dashboard.css',
})
export class HrDashboard implements OnInit {
  private api = inject(ApiService);
  private tour = inject(TourService);
  session = inject(SessionService);

  readonly statusOrder = STATUS_ORDER;
  readonly statusLabels = STATUS_LABELS;

  stats = signal<HrStats | null>(null);
  postings = signal<Posting[]>([]);
  loading = signal(true);
  coLabel = signal('');
  toastMsg = signal<string | null>(null);

  /* ---- finding an opening ----
     The applicant's side has had search, a department filter and a sort
     since it was built; the recruiter's own list had none of it and was
     stuck in insertion order, so a company running two dozen vacancies had
     to read the whole page to find one. The same three controls, plus the
     one filter only this side needs: open vs closed. */
  query = signal('');
  state = signal<'' | 'open' | 'expired' | 'waiting'>('');

  /* ---- the archive ----
     Closed openings used to sit in the same list as the live ones, greyed
     out, so a company that had been hiring for a year scrolled past every
     vacancy it ever filled to find the three it is recruiting for now. They
     are filed under Archive instead: out of the way, one click back, and
     every application in them kept. Reopening one moves it back. */
  view = signal<'current' | 'archive'>('current');
  readonly currentCount = computed(() => this.postings().filter((p) => p.status !== 'closed').length);
  readonly archivedCount = computed(() => this.postings().filter((p) => p.status === 'closed').length);
  /** Closed openings still holding unopened applications, so the Archive
   *  tab can say so rather than hide them. */
  readonly archivedWaiting = computed(() =>
    this.postings().filter((p) => p.status === 'closed' && p.newCount).length);
  setView(v: 'current' | 'archive'): void {
    this.view.set(v);
    this.state.set('');
  }

  /* ---- following a number to where it comes from ----
     Every stage count in the pipeline, and "Waiting for you" in the tally,
     leads to the openings that number is made of. Picking one narrows the
     openings list to those with somebody at that stage, shows how many on
     each row, and sends "Review applicants" to the list already filtered to
     that stage. It looks across current AND archived openings, because an
     applicant waiting in a closed opening is still waiting. */
  stage = signal<AppStatus | ''>('');
  readonly stageLabel = computed(() => { const k = this.stage(); return k ? STATUS_LABELS[k] : ''; });
  stageCount(p: Posting): number {
    const st = this.stage();
    return st ? (this.stats()?.byPosting?.[p.id]?.[st] ?? 0) : 0;
  }
  pickStage(k: AppStatus): void {
    const next = this.stage() === k ? '' : k;
    this.stage.set(next);
    if (next) {
      this.query.set('');
      this.state.set('');
      // After the list has re-rendered, so the scroll lands on the result.
      setTimeout(() => document.getElementById('postSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }
  clearStage(): void { this.stage.set(''); }
  /** Query params for a row's "Review applicants" link. */
  reviewParams(p: Posting): Record<string, string> {
    const st = this.stage();
    return st && this.stageCount(p) ? { id: p.id, status: st } : { id: p.id };
  }
  sort = signal<'new' | 'applicants' | 'az'>('new');

  /* ---- narrowing the dashboard ----
     Three of these are SHARED: they scope the page rather than one list, so
     the pipeline and the openings below it answer the same question. Reading
     "40 applied" over a list filtered to one colleague, where the 40 counted
     the whole company, was the misreading worth designing out.

     An opening narrows both as well, for the same reason: leaving every row
     in place while the counters moved read as a control doing nothing.

     The applicant box is the one exception, and stays pipeline-only — a
     person's name is not a property of a vacancy, so there is no sensible
     way for it to narrow a list OF vacancies. The openings list keeps its
     own search box for finding a role by name. */
  fStaff = signal('');
  fDept = signal('');
  fFrom = signal('');
  fTo = signal('');
  fPosting = signal('');
  fApplicant = signal('');

  staff = signal<{ id: string; name: string }[]>([]);
  statsLoading = signal(false);

  /** Whether anything is narrowing the page, for the "showing everything"
   *  line and the reset control. */
  readonly anyFilter = computed(() =>
    !!(this.fStaff() || this.fDept() || this.fFrom() || this.fTo() || this.fPosting() || this.fApplicant()));

  /** The departments this company actually posts into, derived rather than
   *  configured: a fixed list would offer departments with no openings and
   *  miss any added since. */
  readonly departments = computed<string[]>(() =>
    [...new Set(this.postings().map((p) => p.department).filter(Boolean))].sort());

  visiblePostings = computed<Posting[]>(() => {
    const q = this.query().trim().toLowerCase();
    const state = this.state();
    const staff = this.fStaff();
    const dept = this.fDept();
    // Posted-on, for a list of openings. The pipeline reads the same two
    // boxes as applied-on, because that is the date each list is about.
    const from = this.fFrom() ? Date.parse(this.fFrom() + 'T00:00:00') : NaN;
    const to = this.fTo() ? Date.parse(this.fTo() + 'T00:00:00') + 86400000 : NaN;

    const only = this.fPosting();
    const stage = this.stage();
    const cells = this.stats()?.byPosting ?? {};
    const view = this.view();

    let out = this.postings().filter((p) => {
      // Picking one opening narrows this list to it as well. It was left out
      // at first on the reasoning that a list of one is not worth filtering
      // to — but the effect was a control that changed the counters and left
      // every row in place, which reads as a control that does nothing.
      if (only && p.id !== only) return false;
      if (stage) {
        // A stage looks across current and archived alike (see pickStage).
        if (!(cells[p.id]?.[stage])) return false;
      } else if (!only) {
        // One picked opening is shown wherever it is filed; otherwise the
        // tab decides.
        if (view === 'current' && p.status === 'closed') return false;
        if (view === 'archive' && p.status !== 'closed') return false;
      }
      if (staff && (p.ownerId ?? '') !== staff) return false;
      if (dept && p.department !== dept) return false;
      if (!Number.isNaN(from) && p.createdAt < from) return false;
      if (!Number.isNaN(to) && p.createdAt >= to) return false;
      // "Deadline passed" is a state of its own on this page — an opening
      // still marked open that no longer accepts anyone. Rolling it into
      // "open" would hide exactly the rows that need attention.
      if (state === 'open' && !(p.status === 'open' && !p.expired)) return false;
      if (state === 'expired' && !(p.status === 'open' && p.expired)) return false;
      if (state === 'waiting' && !p.newCount) return false;
      if (!q) return true;
      return (p.title + ' ' + p.department + ' ' + p.skills.join(' ')).toLowerCase().includes(q);
    });

    const by = this.sort();
    out = [...out].sort((a, b) =>
      by === 'az' ? a.title.localeCompare(b.title)
        : by === 'applicants' ? (b.applicantCount ?? 0) - (a.applicantCount ?? 0)
          : b.createdAt - a.createdAt);
    return out;
  });

  onQueryInput(e: Event): void { this.query.set((e.target as HTMLInputElement).value); }
  readonly stateOptions: readonly SelectOption[] = [
    { v: '', label: 'All openings' },
    { v: 'open', label: 'Open and accepting' },
    { v: 'expired', label: 'Deadline passed' },
    { v: 'waiting', label: 'Has new applicants' },
  ];
  readonly sortOptions: readonly SelectOption[] = [
    { v: 'new', label: 'Newest first' },
    { v: 'applicants', label: 'Most applicants first' },
    { v: 'az', label: 'A to Z' },
  ];
  readonly stateLabel = labelFor(this.stateOptions);
  readonly sortLabel = labelFor(this.sortOptions);

  /** The "nothing matches that" button, which has to clear EVERYTHING.
   *
   *  It used to reset only this list's own search, state and sort, from when
   *  those were the only filters on the page. Once the scope bar above could
   *  empty the list too, the button became a button that visibly did nothing
   *  in exactly the case it exists for: the openings are hidden by a
   *  department or a date, you press the one control offered, and the empty
   *  state stays. Whatever emptied the list is what this has to undo. */
  clearFilters(): void {
    this.query.set('');
    this.state.set('');
    this.sort.set('new');
    this.clearScope();
  }

  /** Every narrowing control off, both lists back to the whole company. */
  clearScope(): void {
    this.fStaff.set(''); this.fDept.set('');
    this.fFrom.set(''); this.fTo.set('');
    this.fPosting.set(''); this.fApplicant.set('');
    this.dateErr.set('');
    this.stage.set('');
    void this.loadStats();
  }

  readonly staffOptions = computed<readonly SelectOption[]>(() => [
    { v: '', label: 'Everyone at the company' },
    ...this.staff().map((s) => ({ v: s.id, label: s.name })),
  ]);
  readonly deptOptions = computed<readonly SelectOption[]>(() => [
    { v: '', label: 'All departments' },
    ...this.departments().map((d) => ({ v: d, label: d })),
  ]);
  /** Openings, labelled so that two of them can be told apart.
   *
   *  A company reposts the same role, so "IT Support" is routinely three
   *  separate openings in different departments. Listed by title alone they
   *  were three identical lines: picking one filtered correctly and looked
   *  broken, because nothing on screen said which one had been picked. The
   *  department is appended ONLY where a title is shared, so the common case
   *  stays short and the ambiguous case stops being ambiguous. */
  readonly postingOptions = computed<readonly SelectOption[]>(() => {
    // Newest first, like the list below, so a repost sits above the original.
    const posts = [...this.postings()].sort((a, b) => b.createdAt - a.createdAt);
    const seen = new Map<string, number>();
    const key = (t: string) => t.trim().toLowerCase();
    for (const p of posts) seen.set(key(p.title), (seen.get(key(p.title)) ?? 0) + 1);
    const opts = posts.map((p) => {
      // The department alone did not separate a role reposted into the SAME
      // department, which is the usual repost, so a shared title also
      // carries the date it went up, and whether it has since closed.
      if ((seen.get(key(p.title)) ?? 0) < 2) return { v: p.id, label: p.title };
      const bits = [p.title];
      if (p.department) bits.push(p.department);
      bits.push('posted ' + this.dayYear(p.createdAt));
      if (p.status === 'closed') bits.push('closed');
      return { v: p.id, label: bits.join(' · ') };
    });
    // Reposted twice on the same day: the time it went up tells them apart,
    // and a number does if even that is shared.
    const count = (l: string) => opts.filter((o) => o.label === l).length;
    const byId = new Map(posts.map((p) => [p.id, p]));
    for (const o of opts.filter((x) => count(x.label) > 1)) {
      o.label += ', ' + new Date(byId.get(o.v)!.createdAt).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    }
    const clash = opts.filter((x) => count(x.label) > 1);
    const n = new Map<string, number>();
    for (const o of clash) { const i = (n.get(o.label) ?? 0) + 1; n.set(o.label, i); o.label += ` (${i})`; }
    return [{ v: '', label: 'All openings' }, ...opts];
  });
  readonly staffLabelFn = computed(() => labelFor(this.staffOptions()));
  readonly deptLabelFn = computed(() => labelFor(this.deptOptions()));
  /** What the closed box shows: the short form, title and date, because the
   *  box has a fixed width and the date is the part that tells reposts
   *  apart. The open list keeps the full label. */
  readonly postingLabelFn = computed(() => {
    const full = labelFor(this.postingOptions());
    const byId = new Map(this.postings().map((p) => [p.id, p]));
    return (v: string): string => {
      const label = full(v);
      const p = byId.get(v);
      return p && label !== p.title ? `${p.title} · ${this.day(p.createdAt)}` : label;
    };
  });

  /** Re-count the pipeline for the current filters.
   *
   *  The counters are a server-side aggregate over applications this page
   *  never loads, so narrowing them is a round trip rather than a filter
   *  over something already in hand. Typing in the applicant box therefore
   *  goes through onApplicantInput's debounce; the selects call straight in,
   *  since a dropdown changes once per choice. */
  private statsSeq = 0;
  async loadStats(): Promise<void> {
    const seq = ++this.statsSeq;
    this.statsLoading.set(true);
    const r = await this.api.stats.hr({
      staffId: this.fStaff() || undefined,
      department: this.fDept() || undefined,
      postingId: this.fPosting() || undefined,
      applicant: this.fApplicant().trim() || undefined,
      from: this.fFrom() || undefined,
      to: this.fTo() || undefined,
    });
    // A slower earlier request must not overwrite a newer answer.
    if (seq !== this.statsSeq) return;
    this.statsLoading.set(false);
    if (r.ok) this.stats.set(r.stats);
  }

  setStaff(v: string): void { this.fStaff.set(v); void this.loadStats(); }
  setDept(v: string): void { this.fDept.set(v); void this.loadStats(); }
  setPosting(v: string): void { this.fPosting.set(v); void this.loadStats(); }
  /** Today as the date box writes it (local YYYY-MM-DD), the latest day
   *  either box accepts: nobody has applied tomorrow. */
  readonly today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  dateErr = signal('');
  /** The min/max on the boxes stop the calendar offering an impossible day,
   *  but a date can still be typed, so it is checked here too. An impossible
   *  range is refused with a reason and the box goes back to what it held,
   *  rather than quietly counting nothing. */
  onDateInput(which: 'from' | 'to', e: Event): void {
    const box = e.target as HTMLInputElement;
    const v = box.value;
    const from = which === 'from' ? v : this.fFrom();
    const to = which === 'to' ? v : this.fTo();
    let err = '';
    if (v && v > this.today) err = 'Dates cannot be later than today.';
    else if (from && to && from > to) err = '“Applied from” has to be on or before the “to” date.';
    if (err) {
      this.dateErr.set(err);
      box.value = which === 'from' ? this.fFrom() : this.fTo();
      return;
    }
    this.dateErr.set('');
    (which === 'from' ? this.fFrom : this.fTo).set(v);
    void this.loadStats();
  }

  private applicantTimer: ReturnType<typeof setTimeout> | null = null;
  onApplicantInput(e: Event): void {
    this.fApplicant.set((e.target as HTMLInputElement).value);
    if (this.applicantTimer) clearTimeout(this.applicantTimer);
    this.applicantTimer = setTimeout(() => void this.loadStats(), 300);
  }

  hello = computed(() => {
    const u = this.session.user();
    return u ? 'Good day, ' + u.name.split(' ')[0] + '.' : 'Good day.';
  });

  async ngOnInit(): Promise<void> {
    const user = this.session.user();
    if (user?.companyId) {
      const co = await this.api.companies.get(user.companyId);
      if (co.ok) this.coLabel.set(co.company.name + ' · ' + (user.position || 'HR'));
    }
    await this.render();

    this.tour.init(
      'hr-dashboard',
      [
        { sel: '#tally', title: 'Where things stand', text: `"Waiting for you" is the number that matters. Those are applications nobody has opened yet.` },
        { sel: '#pipe', title: 'Nobody drops off silently', text: `Every applicant sits in one of these five stages. The system never moves anyone between them. You do, and it’s recorded.` },
        { sel: '#postSection', title: 'Your openings', text: `Each row shows how many people applied. Closing an opening stops new applications but keeps everyone you already have.` },
        { sel: '.p-row .btn.primary', title: 'The ranked list', text: `This is the core of it: applicants sorted by compatibility, with the score broken down. And both their structured resume and their own uploaded file.` },
      ],
      { user: user?.id },
    );
  }

  private async render(): Promise<void> {
    this.loading.set(true);
    const [sRes, pRes, stRes] = await Promise.all([
      this.api.stats.hr({
        staffId: this.fStaff() || undefined,
        department: this.fDept() || undefined,
        postingId: this.fPosting() || undefined,
        applicant: this.fApplicant().trim() || undefined,
        from: this.fFrom() || undefined,
        to: this.fTo() || undefined,
      }),
      this.api.postings.mine(),
      this.api.stats.hrStaff(),
    ]);
    if (sRes.ok) this.stats.set(sRes.stats);
    this.postings.set(pRes.ok ? pRes.postings : []);
    // A company with one recruiter has nobody to filter BY, so the picker is
    // hidden rather than offered as a control with one real choice.
    this.staff.set(stRes.ok ? stRes.staff : []);
    this.loading.set(false);
  }

  day(ts: number): string {
    return new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  }
  dayYear(ts: number): string {
    return new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async toggle(p: Posting): Promise<void> {
    const r = await this.api.postings.toggle(p.id);
    if (!r.ok) { this.showToast(r.error); return; }
    await this.render();
    this.showToast(r.posting.status === 'closed'
      ? p.title + ' is closed and filed under Archive. Its applications are kept.'
      : p.title + ' is open again and back with your current openings.');
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
