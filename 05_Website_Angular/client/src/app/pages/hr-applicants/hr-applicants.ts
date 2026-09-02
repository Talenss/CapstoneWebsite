import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl, SafeUrl } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { AppStatus, InviteSchedule, Personal, Posting, RankedRow, RejectionReason, Resume, ScreeningNote, SkillEvidence, StatusEvent, Tier, RankedQuery} from '../../core/models';
import { APPLICANT_REASON_LABELS, EDU_LABELS, EVIDENCE_KIND_LABELS, evidenceSources, experienceLabel, REASON_LABELS, REJECTION_REASONS, STATUS_LABELS, STATUS_ORDER, WEIGHTS, statusBadge, tierColor, tierLabel } from '../../core/engine';
import { FocusTrapDirective } from '../../shared/focus-trap.directive';

/** Port of the PHP hr-applicants.html — the ranked-applicant list
 *  for a single posting (?id=), with a search/filter bar and a dual-resume
 *  detail modal: the structured (scored) resume next to the applicant's
 *  own uploaded file, which is read by software and scored separately. */
@Component({
  selector: 'app-hr-applicants',
  standalone: true,
  imports: [RouterLink, Header, Footer, FocusTrapDirective],
  templateUrl: './hr-applicants.html',
  styleUrl: './hr-applicants.css',
})
export class HrApplicants {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private sanitizer = inject(DomSanitizer);

  readonly statusOrder = STATUS_ORDER;
  readonly experienceLabel = experienceLabel;
  readonly statusLabels = STATUS_LABELS;
  readonly eduLabels = EDU_LABELS;
  readonly weights = WEIGHTS;
  readonly tierColor = tierColor;
  readonly tierLabel = tierLabel;
  readonly statusBadge = statusBadge;

  postingId = signal<string | null>(null);
  posting = signal<Posting | null>(null);
  rows = signal<RankedRow[]>([]);
  loading = signal(true);
  loadError = signal<string | null>(null);

  q = signal('');
  /* PAGING. 25 a page: enough that a recruiter rarely leaves page one on a
     normal opening, small enough that a pool of hundreds does not ship as one
     600 KB response. Filtering is done by the SERVER now — see the route —
     because narrowing a single page would hide matching applicants sitting on
     another page, which is worse than not filtering at all. */
  readonly PAGE_SIZE = 25;
  page = signal(1);
  pages = signal(1);
  /** Everyone who applied, whatever the filters say. */
  total = signal(0);
  /** How many survived the filters, across every page. */
  matched = signal(0);

  fStatus = signal('');
  fTier = signal('');
  fFile = signal('');

  current = signal<RankedRow | null>(null);
  modalStatus = signal<AppStatus>('submitted');
  /** Only sent on a rejection, and even then optional. See saveStatus(). */
  modalReason = signal<string>('');

  /* Screening notes for the open applicant. Recruiter-only end to end: no
     seeker-facing route returns them, which is what makes them worth writing
     candidly. */
  notes = signal<ScreeningNote[]>([]);
  notesLoading = signal(false);
  noteDraft = signal('');
  savingNote = signal(false);
  readonly REASONS = REJECTION_REASONS;
  readonly REASON_LABELS = REASON_LABELS;
  /** What the APPLICANT will read for the code currently picked, previewed
   *  under the control so the recruiter chooses knowing how it lands. A
   *  method because modalReason is a plain string — the empty case is "no
   *  reason", not a key. */
  applicantWording(k: string): string {
    return APPLICANT_REASON_LABELS[k as RejectionReason] ?? '';
  }
  savingStatus = signal(false);

  // ---- message the applicant (interview invite) ----
  inviteOpen = signal(false);
  inviteText = signal('');
  inviteSending = signal(false);
  // Optional interview time. When inviteWhen is set, the email also carries
  // an "Add to Google Calendar" link and an .ics attachment.
  inviteWhen = signal('');
  inviteDuration = signal(60);
  inviteLocation = signal('');

  openInvite(): void {
    const r = this.current();
    if (!r) return;
    const first = (r.seeker.name || '').split(' ')[0] || r.seeker.name;
    this.inviteText.set(
      `Hi ${first},\n\nThank you for applying to ${this.posting()?.title ?? 'our opening'}. We'd like to invite you to an interview. Could you tell us which days and times work for you this coming week?\n\nWe look forward to meeting you.`,
    );
    this.inviteWhen.set('');
    this.inviteDuration.set(60);
    this.inviteLocation.set('');
    this.inviteOpen.set(true);
  }

  setInviteText(e: Event): void {
    this.inviteText.set((e.target as HTMLTextAreaElement).value);
  }
  setInviteWhen(e: Event): void {
    this.inviteWhen.set((e.target as HTMLInputElement).value);
  }
  setInviteDuration(e: Event): void {
    this.inviteDuration.set(Number((e.target as HTMLSelectElement).value) || 60);
  }
  setInviteLocation(e: Event): void {
    this.inviteLocation.set((e.target as HTMLInputElement).value);
  }

  async sendInvite(): Promise<void> {
    const r = this.current();
    if (!r) return;
    // A datetime-local value ("2026-09-10T14:30") has no timezone; new Date()
    // reads it as the recruiter's local time, and toISOString() pins it to an
    // absolute instant so every calendar shows the same wall-clock time.
    let schedule: InviteSchedule | undefined;
    const whenRaw = this.inviteWhen().trim();
    if (whenRaw) {
      const d = new Date(whenRaw);
      if (!Number.isNaN(d.getTime())) {
        schedule = {
          startIso: d.toISOString(),
          durationMinutes: this.inviteDuration(),
          location: this.inviteLocation().trim() || undefined,
        };
      }
    }
    this.inviteSending.set(true);
    const res = await this.api.applications.invite(r.application.id, this.inviteText().trim(), schedule);
    this.inviteSending.set(false);
    if (!res.ok) { this.showToast(res.error); return; }
    this.inviteOpen.set(false);
    const withCal = schedule ? ' A calendar invite was included.' : '';
    this.showToast(res.simulated
      ? `Demo mode, in the real system this message is emailed to ${r.seeker.name}, with replies going to your inbox.${withCal}`
      : `Message emailed to ${r.seeker.name}. Their reply will land in your inbox.${withCal}`);
  }

  toastMsg = signal<string | null>(null);

  /** Shown only on the printed sheet, so a page found on a desk later can be
   *  dated. Fixed at load rather than computed per render — a value that
   *  changes during change detection would be a needless re-render. */
  readonly printedOn = new Date().toLocaleDateString('en-PH', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  /** The rows the server sent for this page. It has already applied the
   *  filters, so there is nothing left to narrow here — the name is kept
   *  because it is what the template asks for, and because "filtered" is
   *  still what these rows are. */
  filteredRows = computed(() => this.rows());

  subLabel = computed(() => {
    const p = this.posting();
    if (!p) return '';
    const n = this.rows().length;
    return (
      n + ' applicant' + (n === 1 ? '' : 's') + ' · asking for ' +
      p.skills.join(', ') + ' · ' + EDU_LABELS[p.educationLevel].toLowerCase() +
      ' · ' + experienceLabel(p.minExperienceMonths || 0).toLowerCase()
    );
  });

  deptLabel = computed(() => {
    const p = this.posting();
    if (!p) return '';
    return p.department + (p.status === 'closed' ? ' · closed' : '');
  });

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('id');
      if (!id) { this.router.navigateByUrl('/hr-dashboard'); return; }
      this.postingId.set(id);
      this.load(id);
    });
  }

  private query(pageSize = this.PAGE_SIZE): RankedQuery {
    return {
      page: this.page(), pageSize,
      q: this.q().trim(), status: this.fStatus(), tier: this.fTier(),
      file: this.fFile() as '' | 'yes' | 'no',
    };
  }

  private async load(id: string): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    const res = await this.api.applications.ranked(id, this.query());
    this.loading.set(false);
    if (!res.ok) { this.loadError.set(res.error); return; }
    this.posting.set(res.posting);
    this.rows.set(res.rows);
    this.total.set(res.total ?? res.rows.length);
    this.matched.set(res.matched ?? res.rows.length);
    this.pages.set(res.pages ?? 1);
    this.page.set(res.page ?? 1);
  }

  /** Re-runs the query. Any change to a filter goes back to page one: staying
   *  on page four of a narrower result is how a recruiter ends up looking at
   *  an empty list and concluding there are no applicants. */
  private async refilter(): Promise<void> {
    this.page.set(1);
    const id = this.postingId();
    if (id) await this.load(id);
  }

  async goToPage(n: number): Promise<void> {
    const target = Math.min(Math.max(1, n), this.pages());
    if (target === this.page()) return;
    this.page.set(target);
    const id = this.postingId();
    if (id) await this.load(id);
    document.getElementById('list')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /** True rank in the whole pool, not position on the page. */
  rank(r: RankedRow): number {
    return (this.page() - 1) * this.PAGE_SIZE + this.rows().indexOf(r) + 1;
  }

  day(ts: number): string {
    return new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  kb(n: number): string {
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }

  tierBadgeClass(t: Tier): string {
    return t === 'strong' ? 'green' : t === 'possible' ? 'amber' : 'slate';
  }

  contactLine(p: Personal): string {
    return [p.email, p.phone, p.address].filter(Boolean).join('  ·  ');
  }
  /** The recruiter's pane shows the same document the applicant sees, so
   *  these mirror the builder's preview and the print sheet exactly. A
   *  section the applicant filled in must not be invisible here. */
  linkLine(p: Personal): string {
    return this.join([p.linkedin, p.portfolio], '  ·  ');
  }
  join(parts: (string | undefined | null)[], sep = ' · '): string {
    return parts.map((x) => (x ?? '').trim()).filter((x) => x !== '').join(sep);
  }
  dateRange(e: { startDate?: string; endDate?: string; current?: boolean }): string {
    const from = (e.startDate || '').trim();
    const to = e.current ? 'Present' : (e.endDate || '').trim();
    if (from && to) return `${from} – ${to}`;
    return from || to || '';
  }
  monthsLabel(months: number): string {
    return months ? `${months} month${months > 1 ? 's' : ''}` : '';
  }
  /** How the file's score compares with the resume the applicant typed. The
   *  sign is the whole point: a document that scores LOWER than what its
   *  owner typed is a document an ordinary screening system would have
   *  under-read — which is the case this project exists to make. */
  fileGap(r: RankedRow): string {
    if (!r.fileScore) return '';
    const d = r.fileScore.score - r.score;
    if (d === 0) return 'same as their typed resume';
    return d > 0 ? `+${d} vs typed` : `${d} vs typed`;
  }

  /** Why there is no file score. Never phrased so it could be mistaken for
   *  a bad score — "could not be read" and "scored zero" are opposites. */
  fileStatusLabel(r: RankedRow): string {
    switch (r.resume.ownFile?.extractStatus) {
      case 'unavailable': return 'automatic reading is off on this server';
      case 'unreadable':  return "this format can't be read by software";
      case 'failed':      return 'could not be read automatically';
      default:            return 'not read';
    }
  }

  languageLine(r: Resume): string {
    return (r.languages ?? []).map((l) => this.join([l.name, l.proficiency], ', ')).join('  ·  ');
  }

  /** The applicant's file, framed for reading.
   *
   *  The viewer's own toolbar is turned off. It shows the source URL as the
   *  document title, and in demo mode that source is a data: URL — so the
   *  recruiter got a wall of base64 across the top of the pane where the file
   *  name should be. The name is already printed under the frame, so nothing
   *  is lost by hiding the bar, and FitH starts the page at a readable width. */
  iframeUrl(resumeId: string | null): SafeResourceUrl | null {
    if (!resumeId) return null;
    const url = this.api.resumes.fileUrl(resumeId);
    if (!url) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url + '#toolbar=0&navpanes=0&statusbar=0&view=FitH');
  }

  imgUrl(resumeId: string | null): string | null {
    if (!resumeId) return null;
    return this.api.resumes.fileUrl(resumeId);
  }

  downloadUrl(resumeId: string | null): SafeUrl | null {
    if (!resumeId) return null;
    const url = this.api.resumes.fileUrl(resumeId);
    return url ? this.sanitizer.bypassSecurityTrustUrl(url) : null;
  }

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounced, because the search now reaches the server: without this every
   *  keystroke is a query, and the replies can arrive out of order. */
  setQuery(e: Event): void {
    this.q.set((e.target as HTMLInputElement).value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { void this.refilter(); }, 250);
  }
  setFStatus(e: Event): void { this.fStatus.set((e.target as HTMLSelectElement).value); void this.refilter(); }
  setFTier(e: Event): void { this.fTier.set((e.target as HTMLSelectElement).value); void this.refilter(); }
  setFFile(e: Event): void { this.fFile.set((e.target as HTMLSelectElement).value); void this.refilter(); }
  setModalStatus(e: Event): void { this.modalStatus.set((e.target as HTMLSelectElement).value as AppStatus); }
  setModalReason(e: Event): void { this.modalReason.set((e.target as HTMLSelectElement).value); }

  /** How far the resume has moved since the application was made, as a signed
   *  string. A method rather than template arithmetic because `liveScore` is
   *  optional — the `scoreDrifted` guard reads as a narrowing to a human but
   *  not to the template compiler, and casting in the template would hide a
   *  real absence rather than handle it. */
  driftLabel(r: RankedRow): string {
    if (r.liveScore == null) return '';
    const d = r.liveScore - r.score;
    return (d > 0 ? '+' : '') + d;
  }
  setNoteDraft(e: Event): void { this.noteDraft.set((e.target as HTMLTextAreaElement).value); }

  readonly evidenceKindLabels = EVIDENCE_KIND_LABELS;

  /** Every source the applicant named for one skill — a skill can be learned
   *  in several places, so this is a list. Empty when they named none, and for
   *  an older resume with no map at all. */
  evidenceOf(r: RankedRow, skill: string): SkillEvidence[] {
    return evidenceSources(r.resume.skillEvidence?.[skill]);
  }

  /** The sources for one skill as a single line for the recruiter view, e.g.
   *  "Work experience — IT Support, Clark BPO · Education — BS IT, HAU".
   *  Empty string when there are none, which the template reads as "no source". */
  evidenceTextOf(r: RankedRow, skill: string): string {
    return this.evidenceOf(r, skill).map((ev) => `${EVIDENCE_KIND_LABELS[ev.kind]} — ${ev.ref}`).join(' · ');
  }

  /* ---------- who already handled this applicant ----------
     Clark Outsourcing routes departments to different HR owners, so several recruiters
     work the same pool. Without this the only thing on screen is the CURRENT
     status: a recruiter opening an applicant cannot tell whether a colleague
     moved them an hour ago or three weeks ago, or who to ask about it. Two
     people then quietly redo each other's decisions.

     The rows have always been written. Here — unlike the applicant's own
     view — they carry the name of the person who made each change, because
     internal accountability is precisely what changed_by is stored for. The
     server decides that; the client only renders what it is given. */
  history = signal<StatusEvent[]>([]);
  historyLoading = signal(false);
  historyError = signal('');

  openModal(r: RankedRow): void {
    this.current.set(r);
    this.modalStatus.set(r.application.status);
    this.modalReason.set('');
    this.noteDraft.set('');
    this.loadHistory(r.application.id);
    this.loadNotes(r.application.id);
  }

  private async loadNotes(applicationId: string): Promise<void> {
    this.notes.set([]);
    this.notesLoading.set(true);
    const res = await this.api.applications.notes(applicationId);
    this.notesLoading.set(false);
    // Same guard as the history load: the recruiter may have moved on, and
    // painting one applicant's notes onto another would be worse than none.
    if (this.current()?.application.id !== applicationId) return;
    if (res.ok) this.notes.set(res.notes);
  }

  async addNote(): Promise<void> {
    const r = this.current();
    const body = this.noteDraft().trim();
    if (!r || !body || this.savingNote()) return;
    this.savingNote.set(true);
    const res = await this.api.applications.noteAdd(r.application.id, body);
    this.savingNote.set(false);
    if (!res.ok) { this.showToast(res.error); return; }
    this.noteDraft.set('');
    await this.loadNotes(r.application.id);
  }

  async deleteNote(noteId: string): Promise<void> {
    const r = this.current();
    if (!r) return;
    const res = await this.api.applications.noteDelete(noteId);
    if (!res.ok) { this.showToast(res.error); return; }
    await this.loadNotes(r.application.id);
  }

  private async loadHistory(applicationId: string): Promise<void> {
    this.history.set([]);
    this.historyError.set('');
    this.historyLoading.set(true);
    const res = await this.api.applications.history(applicationId);
    this.historyLoading.set(false);
    // The recruiter may have closed this one and opened another while the
    // request was in flight; don't paint one applicant's trail onto another.
    if (this.current()?.application.id !== applicationId) return;
    if (!res.ok) { this.historyError.set(res.error); return; }
    this.history.set(res.events);
  }

  /** "Applied", or the move that was made. Phrased from the recruiter's side:
   *  this is a colleague's action, not the reader's own. */
  historyLabel(e: StatusEvent): string {
    if (e.from === null) return 'Applied';
    if (e.to === 'withdrawn') return 'Withdrawn by the applicant';
    return STATUS_LABELS[e.from] + ' → ' + STATUS_LABELS[e.to];
  }

  /** The colleague who made the change. Absent for the applicant's own
   *  actions — the recruiter already knows who that is. */
  historyActor(e: StatusEvent): string {
    return e.by === 'employer' && e.byName ? e.byName : '';
  }

  historyMoment(ts: number): string {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  /** How long this applicant has been waiting since the last thing anyone
   *  did — the number a recruiter actually acts on. */
  waitingSince = computed(() => {
    const ev = this.history();
    if (!ev.length) return '';
    const days = Math.floor((Date.now() - ev[ev.length - 1].at) / 86400000);
    if (days < 1) return 'updated today';
    if (days === 1) return 'waiting 1 day since the last update';
    return 'waiting ' + days + ' days since the last update';
  });

  closeModal(): void {
    this.current.set(null);
    this.history.set([]);
    this.historyError.set('');
  }

  onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.closeModal();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.current()) this.closeModal();
  }

  async saveStatus(): Promise<void> {
    const r = this.current();
    if (!r) return;
    this.savingStatus.set(true);
    const next = this.modalStatus();
    /* The reason is only meaningful on a rejection, and even there it is
       optional — a recruiter forced to pick one in order to proceed picks the
       first item on the list, which fills the column with confident nonsense.
       A blank means nobody stated a reason, which is at least true. */
    const reason = next === 'rejected' ? (this.modalReason() || null) : null;
    const res = await this.api.applications.setStatus(r.application.id, next, reason);
    this.savingStatus.set(false);
    if (!res.ok) { this.showToast(res.error); return; }
    const name = r.seeker.name;
    this.closeModal();
    const id = this.postingId();
    if (id) await this.load(id);
    this.showToast(name + ' → ' + STATUS_LABELS[next] + '. They’ll see it on their dashboard.');
  }

  /* ---------- taking the shortlist off the screen ----------
     Both of these act on filteredRows(), never on rows(): what leaves is
     exactly what the recruiter is looking at. Neither adds any data the
     recruiter cannot already see on this page — they change the format,
     not the access. */

  /** RFC 4180 quoting: double the quotes, wrap anything containing a comma,
   *  quote or newline. Without this a skill list ("Excel, Word") silently
   *  becomes two columns and every row after it is misaligned. */
  private csvCell(v: unknown): string {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  private slugify(s: string): string {
    return (s || 'applicants').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }

  async exportCsv(): Promise<void> {
    /* Asks for every matching row rather than the page on screen. The comment
       below has always said what leaves is exactly what the recruiter filtered
       to; with a pager on the page that is only true if we go and fetch it. */
    const id = this.postingId();
    if (!id) return;
    const all = await this.api.applications.ranked(id, this.query(0));
    const rows = all.ok ? all.rows : this.filteredRows();
    if (!rows.length) return;
    const p = this.posting();

    const header = [
      'Rank', 'Name', 'Email', 'Score', 'Match level', 'Status',
      'Skills matched', 'Skills required', 'Missing skills',
      'Meets education', 'Meets experience', 'Months experience',
      'Own file attached', 'Applied on',
    ];

    const body = rows.map((r, i) => [
      i + 1,
      r.seeker.name,
      r.seeker.email,
      r.score,
      tierLabel(r.score),
      STATUS_LABELS[r.application.status],
      r.matchedSkills.length,
      r.totalSkills,
      r.missingSkills.join('; '),
      r.eduMeets ? 'Yes' : 'No',
      r.expMeets ? 'Yes' : 'No',
      r.seekerMonths,
      r.resume.ownFile ? 'Yes' : 'No',
      new Date(r.application.appliedAt).toISOString().slice(0, 10),
    ].map((c) => this.csvCell(c)).join(','));

    // A BOM, so Excel opens UTF-8 correctly instead of mangling accents —
    // which matters for Filipino names.
    const csv = '﻿' + [header.join(','), ...body].join('\r\n');
    const name = this.slugify(p?.title || 'applicants') + '-applicants.csv';

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.showToast(rows.length + ' applicant' + (rows.length === 1 ? '' : 's') + ' exported to ' + name);
  }

  /** Print the ranked list. print.css hides the page chrome and the filters,
   *  so the sheet carries the posting, the ranking and the reasoning — the
   *  thing a recruiter actually takes into a shortlisting meeting. */
  /** The printed sheet is the whole filtered set too, for the same reason.
   *  The rows are put back afterwards so the pager on screen still matches
   *  the page the recruiter was reading. */
  async printList(): Promise<void> {
    const id = this.postingId();
    const page = this.rows();
    if (id) {
      const all = await this.api.applications.ranked(id, this.query(0));
      if (all.ok) this.rows.set(all.rows);
    }
    setTimeout(() => {
      window.print();
      this.rows.set(page);
    }, 60);
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
