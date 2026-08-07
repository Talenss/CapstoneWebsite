import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { TourService } from '../../shared/tour/tour.service';
import { AppStatus, Application, Posting, RecommendationItem, Resume, StatusEvent } from '../../core/models';
import { EDU_LABELS, STATUS_LABELS, THRESHOLDS, WEIGHTS, scoreLocal, statusBadge, tierColor, tierLabel, tierOf } from '../../core/engine';
import { FocusTrapDirective } from '../../shared/focus-trap.directive';

type TierKey = 'strong' | 'possible' | 'related';
interface Reco { strong: RecommendationItem[]; possible: RecommendationItem[]; related: RecommendationItem[] }
interface TierConfig { key: TierKey; title: string; badgeClass: string; note: string }

/** Port of 04_Website/app/seeker-dashboard.html — the seeker's home base.
 *  Scores their active resume against every open posting (via
 *  api.match.recommendations()) into three tiers, and lists their
 *  applications. Carries the site's only onboarding tour. */
@Component({
  selector: 'app-seeker-dashboard',
  standalone: true,
  imports: [RouterLink, Header, Footer, FocusTrapDirective],
  templateUrl: './seeker-dashboard.html',
  styleUrl: './seeker-dashboard.css',
})
export class SeekerDashboard implements OnInit {
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
    { key: 'strong', title: 'Strong matches', badgeClass: 'green', note: `At or above ${THRESHOLDS.strong}% — your resume already meets most of what the posting asks for.` },
    { key: 'possible', title: 'Possible matches', badgeClass: 'amber', note: `Between ${THRESHOLDS.related}% and ${THRESHOLDS.strong - 1}% — worth applying to. Recruiters read every applicant, not just the top of the list.` },
    { key: 'related', title: 'Related roles', badgeClass: 'slate', note: `Below ${THRESHOLDS.related}%, but you share real skills with these. This is where you get pointed instead of turned away.` },
  ];

  loading = signal(true);
  resumes = signal<Resume[]>([]);
  activeId = signal<string | null>(null);
  reco = signal<Reco | null>(null);
  applications = signal<Application[]>([]);
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

  /** The application the open panel belongs to, so the panel can name it —
   *  it sits below the table rather than inside the row, so "which one is
   *  this?" has to be answered in the panel itself. */
  historyOpenApp = computed(() => this.applications().find((a) => a.id === this.openHistoryId()) ?? null);

  async toggleHistory(a: Application): Promise<void> {
    if (this.openHistoryId() === a.id) { this.openHistoryId.set(null); return; }
    this.openHistoryId.set(a.id);
    this.historyEvents.set([]);
    this.historyError.set('');
    this.historyLoading.set(true);
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
    return 'Moved to ' + STATUS_LABELS[e.to].toLowerCase();
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
    if (!confirm(`Withdraw your application for ${title}?\n\nThe recruiter will see that you withdrew, and you can apply again later if the opening is still accepting applications.`)) return;
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
        { sel: '#picker', title: 'Your active resume', text: 'Every score on this page comes from this one resume. Keep several versions and switch between them — the board re-scores instantly.' },
        { sel: '#board .tier:first-child', title: 'Matches, in three tiers', text: 'Strong, possible, and related. That third tier is the point: a low score redirects you to roles that fit, rather than shutting a door.' },
        { sel: '#board .score-ring', title: 'What the number means', text: 'Skills are half of it, education and experience a quarter each. Open any match to see the full breakdown — the same one the recruiter sees.' },
        { sel: '#appsSection', title: 'Follow your applications', text: 'Submitted, Under review, Shortlisted, Hired, or Not selected. Every one of those is set by a person at Clark Outsourcing — never by the system.' },
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

  day(ts: number): string {
    return new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  tierBadgeClass(score: number): string {
    const t = tierOf(score);
    return t === 'strong' ? 'green' : t === 'possible' ? 'amber' : 'slate';
  }

  async onResumeChange(e: Event): Promise<void> {
    const id = (e.target as HTMLSelectElement).value;
    await this.api.resumes.setActive(id);
    await this.render();
    this.showToast('Active resume changed — everything re-scored.');
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
    if (this.current()) this.closeApply();
  }

  async applyNow(): Promise<void> {
    const item = this.current();
    if (!item) return;
    this.applying.set(true);
    const meRes = await this.api.auth.me();
    const activeResumeId = meRes.ok ? meRes.user?.activeResumeId : null;
    const res = activeResumeId
      ? await this.api.applications.apply(activeResumeId, item.posting.id)
      : ({ ok: false, error: 'No active resume.' } as const);
    this.applying.set(false);
    if (!res.ok) {
      this.showToast(res.error);
      return;
    }
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
