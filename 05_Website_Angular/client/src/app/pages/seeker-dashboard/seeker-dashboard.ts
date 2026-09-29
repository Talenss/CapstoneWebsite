import { DialogService } from '../../shared/dialog/dialog.service';
import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { TourService } from '../../shared/tour/tour.service';
import { AppStatus, Application, ApplicationAnswer, Posting, RecommendationItem, Resume, StatusEvent } from '../../core/models';
import { APPLICANT_REASON_LABELS, EDU_LABELS, missingHint, STATUS_LABELS, THRESHOLDS, WEIGHTS, scoreLocal, statusBadge, tierColor, tierLabel, tierOf } from '../../core/engine';
import { FocusTrapDirective } from '../../shared/focus-trap.directive';
import { ApplyQuestions } from '../../shared/apply-questions/apply-questions';
import { HlmSelectImports } from '@spartan-ng/helm/select';

type TierKey = 'strong' | 'possible' | 'related';
interface Reco { strong: RecommendationItem[]; possible: RecommendationItem[]; related: RecommendationItem[] }
interface TierConfig { key: TierKey; title: string; badgeClass: string; note: string }

/** Port of the PHP seeker-dashboard.html — the seeker's home base.
 *  Scores their active resume against every open posting (via
 *  api.match.recommendations()) into three tiers, and lists their
 *  applications. Carries the site's only onboarding tour. */
@Component({
  selector: 'app-seeker-dashboard',
  standalone: true,
  imports: [RouterLink, Header, Footer, FocusTrapDirective, ApplyQuestions, ...HlmSelectImports],
  templateUrl: './seeker-dashboard.html',
  styleUrl: './seeker-dashboard.css',
})
export class SeekerDashboard implements OnInit {
  private dialog = inject(DialogService);
  private api = inject(ApiService);
  session = inject(SessionService);
  private tour = inject(TourService);

  readonly THRESHOLDS = THRESHOLDS;
  readonly WEIGHTS = WEIGHTS;
  readonly EDU_LABELS = EDU_LABELS;
  readonly STATUS_LABELS = STATUS_LABELS;
  readonly tierColor = tierColor;
  readonly tierLabel = tierLabel;
  readonly statusBadge = statusBadge;

  readonly tiersConfig: TierConfig[] = [
    { key: 'strong', title: 'Strong matches', badgeClass: 'green', note: `At or above ${THRESHOLDS.strong}%. Your resume already meets most of what the posting asks for.` },
    { key: 'possible', title: 'Possible matches', badgeClass: 'amber', note: `Between ${THRESHOLDS.related}% and ${THRESHOLDS.strong - 1}%, worth applying to. Recruiters read every applicant, not just the top of the list.` },
    { key: 'related', title: 'Related roles', badgeClass: 'slate', note: `Below ${THRESHOLDS.related}%, but you share real skills with these. This is where you get pointed instead of turned away.` },
  ];

  loading = signal(true);
  resumes = signal<Resume[]>([]);
  activeId = signal<string | null>(null);
  reco = signal<Reco | null>(null);
  /* Every open posting, including any the tiers dropped. A sub-threshold
     posting that shares no skill is deliberately left out of the related
     tier, so all three can be empty while openings exist — this is how the
     empty state tells "nothing posted" from "nothing matched you". */
  openCount = signal(0);
  applications = signal<Application[]>([]);

  /* FILTERS ON "MY APPLICATIONS" — by status and by the day applied. Dates
     compare as local calendar days (YYYY-MM-DD), which is how the table
     prints them, so "to Sep 18" includes everything applied on Sep 18. The
     date pickers refuse the future and a "from" later than "to". */
  appStatusF = signal('');
  appFrom = signal('');
  appTo = signal('');
  readonly todayISO = new Date().toLocaleDateString('en-CA');
  private dayOf = (ms: number) => new Date(ms).toLocaleDateString('en-CA');
  /** Only statuses the applicant actually has, so no choice leads to nothing. */
  appStatusOptions = computed(() => [{ v: '', label: 'All statuses' },
    ...[...new Set(this.applications().map((a) => a.status))].map((v) => ({ v, label: STATUS_LABELS[v as AppStatus] ?? v }))]);
  readonly appStatusLabel = (v: string): string =>
    this.appStatusOptions().find((o) => o.v === (v ?? ''))?.label ?? 'All statuses';
  filteredApps = computed(() => {
    const st = this.appStatusF(), from = this.appFrom(), to = this.appTo();
    return this.applications().filter((a) => {
      if (st && a.status !== st) return false;
      const d = this.dayOf(a.appliedAt);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  });
  appFiltersOn = computed(() => !!(this.appStatusF() || this.appFrom() || this.appTo()));
  clearAppFilters(): void { this.appStatusF.set(''); this.appFrom.set(''); this.appTo.set(''); }
  dateOf(e: Event): string { return (e.target as HTMLInputElement).value; }

  current = signal<RecommendationItem | null>(null);
  applying = signal(false);
  toastMsg = signal<string | null>(null);
  savedPostings = signal<Posting[]>([]);

  async unsave(p: Posting): Promise<void> {
    const res = await this.api.saved.toggle(p.id);
    if (res.ok) this.savedPostings.update((list) => list.filter((x) => x.id !== p.id));
  }

  deadlineLabel(p: Posting): string | null {
    if (!p.deadline) return null;
    return 'Apply by ' + new Date(p.deadline + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  }

  hello = computed(() => {
    const name = this.session.user()?.name ?? '';
    return `Hello, ${name.split(' ')[0] ?? ''}.`;
  });

  activeResume = computed(() => this.resumes().find((r) => r.id === this.activeId()) ?? null);

  /** The trigger shows the resume's title, not its id. */
  readonly resumeLabel = (id: string): string => {
    const r = this.resumes().find((x) => (x.id ?? '') === id);
    return r ? `${r.title}${r.ownFile ? ' · file attached' : ''}` : 'Choose a resume';
  };

  withdrawingId = signal<string | null>(null);

  /* ---- the applicant's own audit trail -------------------------------
     Every status change has always been recorded, but only the researcher
     metrics page ever read those rows. So an applicant could see that they
     were "Shortlisted" without knowing when it happened, how long it sat in
     review, or — if they missed the email — that anything had changed at
     all. The record is about them; they should be able to read it.

     Loaded on demand rather than with the table: most people open at most
     one, and fetching a timeline for every row would be a request per
     application on every dashboard load for something usually unread. */
  openHistoryId = signal<string | null>(null);
  historyLoading = signal(false);
  historyEvents = signal<StatusEvent[]>([]);
  historyError = signal('');

  /** Nudge the panel into view only if opening it pushed it past the fold.
   *
   *  The panel now opens directly under its own row, so the row the person
   *  just clicked is by definition already on screen and there is nothing to
   *  scroll to in the ordinary case. What can still happen is that the panel
   *  opens on the LAST visible row and its lower half falls below the fold.
   *  'nearest' covers exactly that and does nothing otherwise, so the page
   *  does not jump under someone who could already see what they opened.
   *
   *  rAF twice rather than a timeout: the first frame is where Angular
   *  flushes the signal change that renders the row, the second is after the
   *  browser has laid it out, which is the earliest point it can be scrolled
   *  to. This only ever runs from a click, so the browser APIs are present. */
  private revealHistoryPanel(id: string): void {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.getElementById('hist-' + id)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }));
  }

  async toggleHistory(a: Application): Promise<void> {
    if (this.openHistoryId() === a.id) { this.openHistoryId.set(null); return; }
    this.openHistoryId.set(a.id);
    this.historyEvents.set([]);
    this.historyError.set('');
    this.historyLoading.set(true);
    this.revealHistoryPanel(a.id);
    const res = await this.api.applications.history(a.id);
    this.historyLoading.set(false);
    // Another row may have been opened while this was in flight.
    if (this.openHistoryId() !== a.id) return;
    if (!res.ok) { this.historyError.set(res.error); return; }
    this.historyEvents.set(res.events);
  }

  /** What the applicant reads on each line. The first event is applying —
   *  which the applicant did — so it is phrased in their own voice rather
   *  than as something done to them. */
  historyLabel(e: StatusEvent): string {
    if (e.from === null) return 'You applied';
    if (e.to === 'withdrawn') return 'You withdrew this application';
    // Several pipeline labels begin with "For " (For scheduling, For initial
    // interview…), which reads as a state on a badge but as a stumble after
    // "Moved to". Drop that lead-in here only.
    const label = STATUS_LABELS[e.to].replace(/^For /, '');
    return 'Moved to ' + label.toLowerCase();
  }

  /** How many requirements are unmet and of what kind, never which ones —
   *  see missingHint() in core/engine.ts. */
  readonly missingHint = missingHint;

  /** Why the employer moved this application, addressed to the person it is
   *  about rather than filed in the recruiter's own wording. Empty when no
   *  reason was recorded, which is common and is not itself a message. */
  reasonText(e: StatusEvent): string {
    return e.reason ? APPLICANT_REASON_LABELS[e.reason] : '';
  }

  /** Attribution, deliberately at the level of the employer rather than a
   *  named individual — see the note on the server route. */
  historyBy(e: StatusEvent): string {
    if (e.by === 'applicant') return '';
    return 'by the hiring team';
  }

  /** Gap since the previous event, so "sat in review for three weeks" is
   *  visible rather than something the applicant has to work out. */
  historyGap(i: number): string {
    const ev = this.historyEvents();
    if (i === 0) return '';
    const days = Math.round((ev[i].at - ev[i - 1].at) / 86400000);
    if (days < 1) return 'same day';
    if (days === 1) return '1 day later';
    return days + ' days later';
  }

  historyMoment(ts: number): string {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  /** Withdrawing is offered only while the outcome is still open — once a
   *  person has decided (hired / not selected) there's nothing to withdraw. */
  canWithdraw(a: Application): boolean {
    return a.status !== 'withdrawn' && a.status !== 'hired' && a.status !== 'rejected';
  }

  async withdraw(a: Application): Promise<void> {
    const title = a.posting?.title ?? 'this position';
    if (!(await this.dialog.confirm({
      title: `Withdraw your application for ${title}?`,
      message: 'The recruiter will see that you withdrew, and you can apply again later if the opening is still accepting applications.',
      confirmLabel: 'Withdraw application', cancelLabel: 'Keep it', danger: true,
    }))) return;
    this.withdrawingId.set(a.id);
    const res = await this.api.applications.withdraw(a.id);
    this.withdrawingId.set(null);
    if (!res.ok) {
      this.showToast(res.error);
      return;
    }
    this.applications.update((list) => list.map((x) => (x.id === a.id ? { ...x, status: res.application.status } : x)));
    // Withdrawing writes a history row. If this application's timeline is
    // open, it is now one event short of the truth — refetch rather than
    // leave the applicant reading a record that omits what they just did.
    if (this.openHistoryId() === a.id) {
      this.openHistoryId.set(null);
      await this.toggleHistory(a);
    }
    this.showToast(`Withdrawn from ${title}.`);
  }

  /** Where this score COULD go if the missing skills were on the resume.
   *  Run through the same engine (not an estimate) with the missing
   *  skills added to a copy of the active resume, so the number shown is
   *  exactly what the seeker would score. Returns null when there's
   *  nothing to gain — never nags someone who already matches. */
  projectedScore(item: RecommendationItem): number | null {
    const r = this.activeResume();
    if (!r || !item.missingSkills.length) return null;
    const projected = scoreLocal(
      { ...r, skills: [...r.skills, ...item.missingSkills] },
      item.posting,
    ).score;
    return projected > item.score ? projected : null;
  }

  /** The tier that projected score would land in — so the advice can say
   *  "…which would make this a strong match", not just a bigger number. */
  projectedTier(item: RecommendationItem): string {
    const p = this.projectedScore(item);
    return p === null ? '' : tierLabel(p).toLowerCase();
  }
  activeResumeTitle = computed(() => this.activeResume()?.title ?? '');
  activeResumeHasFile = computed(() => !!this.activeResume()?.ownFile);

  totalReco = computed(() => {
    const r = this.reco();
    return r ? r.strong.length + r.possible.length + r.related.length : 0;
  });

  async ngOnInit(): Promise<void> {
    await this.render();
    const uid = this.session.user()?.id;
    this.tour.init(
      'seeker-dashboard',
      [
        { sel: '#picker', title: 'Your active resume', text: 'Every score on this page comes from this one resume. Keep several versions and switch between them, the board re-scores instantly.' },
        { sel: '#board .tier:first-child', title: 'Matches, in three tiers', text: 'Strong, possible, and related. That third tier is the point: a low score redirects you to roles that fit, rather than shutting a door.' },
        { sel: '#board .score-ring', title: 'What the number means', text: 'Skills usually count for the most, with education and experience behind them. Open any match to see the exact breakdown for that opening. Each one sets its own balance, and it is the same breakdown the recruiter sees.' },
        { sel: '#appsSection', title: 'Follow your applications', text: 'Submitted, Under review, Shortlisted, Hired, or Not selected. Every one of those is set by a person at Clark Outsourcing, never by the system.' },
        { sel: '[data-tour]', title: 'Lost? Come back here', text: 'This tour is always available from this button, on every page. Nothing you do here is permanent until you say so.' },
      ],
      { user: uid },
    );
  }

  private async render(): Promise<void> {
    this.api.saved.list().then((sRes) => { if (sRes.ok) this.savedPostings.set(sRes.postings); });
    const [rRes, meRes] = await Promise.all([this.api.resumes.mine(), this.api.auth.me()]);
    const resumes = rRes.ok ? rRes.resumes : [];
    this.resumes.set(resumes);

    if (!resumes.length) {
      this.reco.set(null);
      this.activeId.set(null);
      await this.renderApps();
      this.loading.set(false);
      return;
    }

    const me = meRes.ok ? meRes.user : null;
    let activeId = me?.activeResumeId || null;
    if (!activeId || !resumes.some((r) => r.id === activeId)) {
      activeId = resumes[0].id;
      if (activeId) await this.api.resumes.setActive(activeId);
    }
    this.activeId.set(activeId);

    const recoRes = await this.api.match.recommendations();
    this.reco.set(
      recoRes.ok
        ? { strong: recoRes.strong, possible: recoRes.possible, related: recoRes.related }
        : { strong: [], possible: [], related: [] },
    );
    this.openCount.set(recoRes.ok ? (recoRes.openCount ?? 0) : 0);

    await this.renderApps();
    this.loading.set(false);
  }

  private async renderApps(): Promise<void> {
    const res = await this.api.applications.mine();
    this.applications.set(res.ok ? res.applications : []);
  }

  countByStatus(status: AppStatus): number {
    return this.applications().filter((a) => a.status === status).length;
  }

  /** "In progress" = with a recruiter and still moving: every pipeline stage
   *  between applying and a shortlist, plus the legacy 'review'. Written as a
   *  set of the stages that are NOT in progress so a new pipeline stage is
   *  counted by default rather than silently dropped from the summary — the
   *  bug that appeared when the pipeline grew from six stages to eight. */
  inProgressCount(): number {
    const settled = new Set<AppStatus>(['shortlisted', 'hired', 'rejected', 'withdrawn']);
    return this.applications().filter((a) => !settled.has(a.status)).length;
  }

  day(ts: number): string {
    return new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  tierBadgeClass(score: number): string {
    const t = tierOf(score);
    return t === 'strong' ? 'green' : t === 'possible' ? 'amber' : 'slate';
  }

  async pickResume(id: string): Promise<void> {
    if (!id || id === this.activeId()) return;
    await this.api.resumes.setActive(id);
    await this.render();
    this.showToast('Active resume changed, everything re-scored.');
  }

  openApply(item: RecommendationItem): void {
    this.current.set(item);
  }

  closeApply(): void {
    this.current.set(null);
  }

  onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.closeApply();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    // Topmost first: the question dialog opens over the opening's own sheet.
    if (this.asking()) { this.cancelAsk(); return; }
    if (this.current()) this.closeApply();
  }

  /* THE OPENING'S SCREENING QUESTIONS, when it has any. Same component and
     same rule as Browse: a question that is mandatory on one screen and
     skippable on the other is not mandatory. */
  asking = signal<RecommendationItem | null>(null);

  applyNow(): void {
    const item = this.current();
    if (!item) return;
    if ((item.posting.questions ?? []).length) { this.asking.set(item); return; }
    void this.send(item, []);
  }

  cancelAsk(): void { this.asking.set(null); }

  onAnswered(answers: ApplicationAnswer[]): void {
    const item = this.asking();
    if (item) void this.send(item, answers);
  }

  private async send(item: RecommendationItem, answers: ApplicationAnswer[]): Promise<void> {
    this.applying.set(true);
    const meRes = await this.api.auth.me();
    const activeResumeId = meRes.ok ? meRes.user?.activeResumeId : null;
    const res = activeResumeId
      ? await this.api.applications.apply(activeResumeId, item.posting.id, answers)
      : ({ ok: false, error: 'No active resume.' } as const);
    this.applying.set(false);
    if (!res.ok) {
      // The dialog stays open so the answers just typed are not thrown away.
      this.showToast(res.error);
      return;
    }
    this.asking.set(null);
    const title = item.posting.title;
    this.closeApply();
    await this.render();
    this.showToast(`Applied to ${title}. Track it below.`);
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
