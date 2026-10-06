import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl, SafeUrl } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { AppStatus, Education, Experience, InviteSchedule, Personal, Posting, RankedRow, RejectionReason, Resume, ScreeningNote, SkillEvidence, StatusEvent, Tier, RankedQuery} from '../../core/models';
import { experienceInPrintOrder, JOB_FIELD_OPTIONS, APPLICANT_REASON_LABELS, EDU_LABELS, EDU_RANK, EVIDENCE_KIND_LABELS, evidenceSources, experienceLabel, REASON_LABELS, REJECTION_REASONS, STATUS_LABELS, STATUS_ORDER, WEIGHTS, statusBadge, tierColor, tierLabel } from '../../core/engine';
import { FocusTrapDirective } from '../../shared/focus-trap.directive';
import { HlmDatePickerImports } from '@spartan-ng/helm/date-picker';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { labelFor, SelectOption } from '../../shared/select-options';
import { describeSchedule, googleCalendarUrl } from '../../core/calendar';
import { DialogService } from '../../shared/dialog/dialog.service';

/** Port of the PHP hr-applicants.html — the ranked-applicant list
 *  for a single posting (?id=), with a search/filter bar and a dual-resume
 *  detail modal: the structured (scored) resume next to the applicant's
 *  own uploaded file, which is read by software and scored separately. */
@Component({
  selector: 'app-hr-applicants',
  standalone: true,
  imports: [RouterLink, Header, Footer, FocusTrapDirective, ...HlmDatePickerImports, ...HlmSelectImports],
  templateUrl: './hr-applicants.html',
  styleUrl: './hr-applicants.css',
})
export class HrApplicants {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private sanitizer = inject(DomSanitizer);
  private dialog = inject(DialogService);

  readonly statusOrder = STATUS_ORDER;
  readonly experienceLabel = experienceLabel;
  /** Jobs still held first, the order every screen prints them in. */
  readonly printOrder = experienceInPrintOrder;
  readonly statusLabels = STATUS_LABELS;
  readonly eduLabels = EDU_LABELS;

  /** The weights actually in force for THIS opening, as whole percentages.
   *  An opening may rebalance them; when it has not, it inherits the site
   *  defaults, so the rail shows what was used either way rather than always
   *  quoting 50/25/25. */
  private pct(v: number): number { return Math.round(v * 100); }
  readonly wSkills = computed(() => this.posting()?.weights?.skills ?? this.pct(WEIGHTS.skills));
  readonly wEdu = computed(() => this.posting()?.weights?.education ?? this.pct(WEIGHTS.education));
  readonly wExp = computed(() => this.posting()?.weights?.experience ?? this.pct(WEIGHTS.experience));
  /* The optional four. They default to 0 rather than to a site default,
     because an opening that never set them does not score them at all. */
  readonly wCert = computed(() => this.posting()?.weights?.certifications ?? 0);
  readonly wProj = computed(() => this.posting()?.weights?.projects ?? 0);
  readonly wLang = computed(() => this.posting()?.weights?.languages ?? 0);
  readonly wRef = computed(() => this.posting()?.weights?.references ?? 0);

  /** Where this opening's applicants stand.
   *
   *  Counted from a deliberately UNFILTERED fetch, not from rows(): that
   *  holds the current page of the current filter, so a tally taken from it
   *  would quietly change as the recruiter typed in the search box and would
   *  disagree with the total printed beside it. Refreshed whenever a status
   *  is changed on this page, since that is the one action that moves it. */
  private tally = signal<{ key: AppStatus; n: number }[]>([]);
  readonly statusCounts = this.tally.asReadonly();

  private async countStatuses(id: string): Promise<void> {
    const all = await this.api.applications.ranked(id, { page: 1, pageSize: 0 });
    if (!all.ok) { this.tally.set([]); return; }
    const counted = new Map<AppStatus, number>();
    for (const r of all.rows) counted.set(r.application.status, (counted.get(r.application.status) ?? 0) + 1);
    // Only stages holding somebody: a column of zeroes says nothing and pushes
    // the ones that matter off the screen.
    this.tally.set(
      this.statusOrder.filter((k) => counted.get(k)).map((k) => ({ key: k, n: counted.get(k) as number })),
    );
  }
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
  /** "Hide applicants below 50%", from the expert review. An option, never
   *  the default: the list opens showing everyone, as it always has, and a
   *  recruiter who wants a shorter list switches it on for themselves. */
  readonly LOW_CUTOFF = 50;
  hideLow = signal(false);
  /** How many the switch is leaving out, under the other filters. */
  belowMin = signal(0);

  current = signal<RankedRow | null>(null);
  /** The resume pane filling the whole window, if any. A recruiter reading an
   *  applicant properly wants the page, not a half-width box inside a dialog. */
  fullPane = signal<'scored' | 'human' | null>(null);

  /* SELECTING SEVERAL APPLICANTS. A BPO screens in volume: moving ten people
     to Initial interview one dialog at a time is ten round trips through the
     same panel. Ticked rows can be moved together, or 2–3 of them compared
     side by side. The selection is of what is on screen, so it is cleared
     whenever the list reloads (a filter, a page, a save). */
  selected = signal<ReadonlySet<string>>(new Set());
  bulkStatus = signal<AppStatus>('initial_interview');
  bulkBusy = signal(false);
  comparing = signal(false);
  readonly MAX_COMPARE = 3;
  selectedRows = computed(() => this.filteredRows().filter((r) => this.selected().has(r.application.id)));
  isSelected(r: RankedRow): boolean { return this.selected().has(r.application.id); }
  toggleSelect(r: RankedRow, e?: Event): void {
    e?.stopPropagation();
    const next = new Set(this.selected());
    if (next.has(r.application.id)) next.delete(r.application.id); else next.add(r.application.id);
    this.selected.set(next);
  }
  allSelected = computed(() => this.filteredRows().length > 0 && this.filteredRows().every((r) => this.selected().has(r.application.id)));
  toggleSelectAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.filteredRows().map((r) => r.application.id)));
  }
  clearSelection(): void { this.selected.set(new Set()); this.comparing.set(false); }
  onBulkStatus(v: AppStatus): void { if (v) this.bulkStatus.set(v); }

  async moveSelected(): Promise<void> {
    const rows = this.selectedRows();
    const to = this.bulkStatus();
    if (!rows.length) return;
    const n = rows.length;
    const ok = await this.dialog.confirm({
      title: `Move ${n} applicant${n === 1 ? '' : 's'} to ${STATUS_LABELS[to]}?`,
      message: rows.map((r) => r.seeker.name).join(', ') + '. Each change is recorded against your account, and each applicant sees it on their dashboard.',
      confirmLabel: `Move ${n}`,
      danger: to === 'rejected',
    });
    if (!ok) return;
    this.bulkBusy.set(true);
    const failed: string[] = [];
    let closed = false;
    // One at a time, not in parallel: the last hire can close the opening,
    // and every change after that must see it closed.
    for (const r of rows) {
      if (r.application.status === to) continue;
      const res = await this.api.applications.setStatus(r.application.id, to, null);
      if (!res.ok) failed.push(`${r.seeker.name} (${res.error})`);
      else if ((res as any).postingClosed) closed = true;
    }
    this.bulkBusy.set(false);
    this.clearSelection();
    const id = this.postingId();
    if (id) await this.load(id);
    const moved = n - failed.length;
    this.showToast(failed.length
      ? `${moved} moved to ${STATUS_LABELS[to]}. Not moved: ${failed.join('; ')}`
      : `${moved} moved to ${STATUS_LABELS[to]}.${closed ? ' That fills every opening, so this posting is now closed to new applicants.' : ''}`);
  }

  openCompare(): void {
    const n = this.selectedRows().length;
    if (n >= 2 && n <= this.MAX_COMPARE) this.comparing.set(true);
  }
  closeCompare(): void { this.comparing.set(false); }
  /** The highest education on a resume, as the compare table shows it. */
  topDegree(r: RankedRow): string {
    const ed = [...(r.resume.education || [])].sort((a, b) => (EDU_RANK[b.level] ?? 0) - (EDU_RANK[a.level] ?? 0))[0];
    if (!ed) return 'None listed';
    return (ed.field ? `${ed.degree}, ${ed.field}` : ed.degree) || EDU_LABELS[ed.level] || 'Listed';
  }
  eduWord(r: RankedRow): string {
    return r.eduMeets ? 'meets' : (r.eduLevelMeets && r.eduFieldRelated === false ? 'other field · counts half' : 'below');
  }
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
  //
  // Held as a date and a time separately. A single datetime-local control is
  // one field in the markup but two unlabelled sub-fields on screen, and its
  // keyboard behaviour differs across browsers; a calendar for the day and a
  // plain time box for the hour is the same information said clearly.
  // inviteWhen recombines them into the value the API already expects.
  inviteDate = signal('');
  inviteTime = signal('');
  readonly inviteWhen = computed(() => {
    const d = this.inviteDate(), t = this.inviteTime();
    return d && t ? `${d}T${t}` : '';
  });
  readonly inviteDateObj = computed<Date | undefined>(() => {
    const [y, m, d] = this.inviteDate().split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : undefined;
  });
  readonly todayDate = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  /** The employer's name, as the invitation email will say it. Looked up the
   *  same way the dashboard does; the posting carried on this page does not
   *  include the company object, so without this the preview said "at the
   *  company" while the email said "at Clark Outsourcing". */
  private companyName = signal('');

  /** The wording and the link the invite will carry, built from the same code
   *  the server uses so what the recruiter checks here is what is sent. Null
   *  until a date and a time are both set, which is also when the email starts
   *  carrying a calendar at all. */
  readonly invitePreview = computed(() => {
    const raw = this.inviteWhen();
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    const sch = {
      startIso: d.toISOString(),
      durationMinutes: this.inviteDuration(),
      location: this.inviteLocation().trim() || undefined,
    };
    const title = `Interview: ${this.posting()?.title ?? 'your application'} at ${this.companyName() || 'your employer'}`;
    const details = `Interview for your ${this.posting()?.title ?? ''} application with ${this.companyName() || 'your employer'}.`;
    const url = googleCalendarUrl(sch, title, details);
    const when = describeSchedule(sch);
    return url && when ? { url, when } : null;
  });
  inviteDuration = signal(60);
  inviteLocation = signal('');

  openInvite(): void {
    const r = this.current();
    if (!r) return;
    const first = (r.seeker.name || '').split(' ')[0] || r.seeker.name;
    this.inviteText.set(
      `Hi ${first},\n\nThank you for applying to ${this.posting()?.title ?? 'our opening'}. We'd like to invite you to an interview. Could you tell us which days and times work for you this coming week?\n\nWe look forward to meeting you.`,
    );
    this.inviteDate.set('');
    this.inviteTime.set('');
    this.inviteDuration.set(60);
    this.inviteLocation.set('');
    this.inviteOpen.set(true);
  }

  setInviteText(e: Event): void {
    this.inviteText.set((e.target as HTMLTextAreaElement).value);
  }
  onInviteDateChange(d: Date | null): void {
    if (!d) { this.inviteDate.set(''); return; }
    const p = (n: number) => String(n).padStart(2, '0');
    this.inviteDate.set(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  setInviteTime(e: Event): void {
    this.inviteTime.set((e.target as HTMLInputElement).value);
  }
  clearInviteDate(): void { this.inviteDate.set(''); }

  /** en-PH short form, matching every other date shown on the site, in place
   *  of the picker's default Date.toDateString ("Wed Sep 23 2026"). */
  readonly formatPickedDate = (d: Date): string =>
    d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
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
      // Arriving from a pipeline stage on the dashboard opens the list
      // already narrowed to that stage, so the number clicked is the list
      // shown. Anything unrecognised is ignored rather than trusted.
      const st = params.get('status');
      this.fStatus.set(st && (this.statusOrder as string[]).includes(st) ? st : '');
      this.load(id);
      void this.loadCompany();
    });
  }

  private async loadCompany(): Promise<void> {
    const me = await this.api.auth.me();
    const cid = me.ok ? me.user?.companyId : null;
    if (!cid) return;
    const co = await this.api.companies.get(cid);
    if (co.ok) this.companyName.set(co.company.name);
  }

  private query(pageSize = this.PAGE_SIZE): RankedQuery {
    return {
      page: this.page(), pageSize,
      q: this.q().trim(), status: this.fStatus(), tier: this.fTier(),
      file: this.fFile() as '' | 'yes' | 'no',
      minScore: this.hideLow() ? this.LOW_CUTOFF : 0,
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
    this.clearSelection();
    this.total.set(res.total ?? res.rows.length);
    this.matched.set(res.matched ?? res.rows.length);
    this.belowMin.set(res.belowMin ?? 0);
    this.pages.set(res.pages ?? 1);
    this.page.set(res.page ?? 1);
    void this.countStatuses(id);
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
  /** The applicant's stated field of work for a job, by its label; null for
   *  "something else", which says nothing worth showing. */
  jobFieldName(v: string): string | null {
    return JOB_FIELD_OPTIONS.find((o) => o.value === v)?.label ?? null;
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

  /* ============================================================
     THE BIG THREE, AT A GLANCE.

     What a recruiter actually reads first: what this person does, what they
     studied, and what they can do. All three are already further down the
     panel inside the full resume; the point of repeating them at the top is
     that a screening decision is usually made in the first few seconds, and
     until now those seconds were spent scrolling a document.

     Nothing here is computed, inferred or extracted. It is the applicant's
     own most recent entry, shown as they wrote it. The system does not read
     a title out of prose and decide what somebody's job is.
     ============================================================ */

  /** The current post if one is marked current, otherwise the most recent
   *  entry — which is the first, because the builder keeps experience in the
   *  order the applicant arranged it and asks them to lead with the latest. */
  currentRole(r: Resume): Experience | null {
    const list = r.experience ?? [];
    return list.find((e) => e.current) ?? list[0] ?? null;
  }

  /** What that post involved, in the applicant's own words. The bullets are
   *  the richer form where they exist; `description` is the prose fallback
   *  every older resume carries. Trimmed to a couple of lines by CSS rather
   *  than cut here, so nothing is lost — the full text is in the pane below. */
  roleSummary(r: Resume): string {
    const e = this.currentRole(r);
    if (!e) return '';
    const bullets = (e.bullets ?? []).filter(Boolean);
    return bullets.length ? bullets.join(' · ') : (e.description ?? '').trim();
  }

  /** Highest qualification by rank, not by position in the list: an applicant
   *  who typed their bachelor's below their high school should still read as
   *  a graduate. Ties keep the first, which is their own ordering. */
  topEducation(r: Resume): Education | null {
    let best: Education | null = null;
    for (const e of r.education ?? []) {
      if (!best || (EDU_RANK[e.level] ?? 0) > (EDU_RANK[best.level] ?? 0)) best = e;
    }
    return best;
  }

  /** Required skills first and marked, then the rest. A recruiter scanning
   *  this line wants to know what the opening asked for before what else the
   *  applicant happens to have. */
  glanceSkills(r: RankedRow): { name: string; required: boolean }[] {
    const matched = new Set(r.matchedSkills.map((s) => s.toLowerCase()));
    const all = r.resume.skills ?? [];
    const required = all.filter((s) => matched.has(s.toLowerCase())).map((name) => ({ name, required: true }));
    const rest = all.filter((s) => !matched.has(s.toLowerCase())).map((name) => ({ name, required: false }));
    return [...required, ...rest];
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
  onFStatus(v: string): void { this.fStatus.set(v ?? ''); void this.refilter(); }
  onFTier(v: string): void { this.fTier.set(v ?? ''); void this.refilter(); }
  onFFile(v: string): void { this.fFile.set(v ?? ''); void this.refilter(); }
  onHideLow(e: Event): void { this.hideLow.set((e.target as HTMLInputElement).checked); void this.refilter(); }
  showLow(): void { this.hideLow.set(false); void this.refilter(); }
  onModalStatus(v: AppStatus): void { this.modalStatus.set(v); }

  /** The filter bar, the status control and the interview length all store
   *  plain codes, so each needs to say how a code reads as words. The labels
   *  themselves come from the shared maps the rest of the page already uses,
   *  so nothing is written down twice. */
  readonly tierOptions: readonly SelectOption[] = [
    { v: '', label: 'All match levels' },
    { v: 'strong', label: 'Strong only' },
    { v: 'possible', label: 'Possible only' },
    { v: 'related', label: 'Below threshold' },
  ];
  readonly fileOptions: readonly SelectOption[] = [
    { v: '', label: 'Any attachment' },
    { v: 'yes', label: 'Has own file' },
    { v: 'no', label: 'System resume only' },
  ];
  readonly durationOptions: readonly SelectOption[] = [
    { v: '30', label: '30 minutes' },
    { v: '45', label: '45 minutes' },
    { v: '60', label: '1 hour' },
    { v: '90', label: '1½ hours' },
    { v: '120', label: '2 hours' },
  ];
  readonly fTierLabel = labelFor(this.tierOptions);
  readonly fFileLabel = labelFor(this.fileOptions);
  readonly durationLabel = labelFor(this.durationOptions);
  readonly fStatusLabel = (v: string): string => (v ? this.statusLabels[v as AppStatus] : 'All statuses');
  readonly statusLabel = (v: AppStatus): string => this.statusLabels[v] ?? String(v ?? '');
  readonly reasonLabel = (v: string): string =>
    v ? (this.REASON_LABELS[v as RejectionReason] ?? v) : 'No reason given';
  readonly String = String;

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
    return this.evidenceOf(r, skill).map((ev) => `${EVIDENCE_KIND_LABELS[ev.kind]}: ${ev.ref}`).join(' · ');
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

  toggleFull(pane: 'scored' | 'human'): void {
    this.fullPane.set(this.fullPane() === pane ? null : pane);
  }

  closeModal(): void {
    this.fullPane.set(null);
    this.current.set(null);
    this.history.set([]);
    this.historyError.set('');
  }

  onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.closeModal();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    // Esc steps back one level: out of full screen first, then out of the dialog.
    if (this.fullPane()) this.fullPane.set(null);
    else if (this.current()) this.closeModal();
    else if (this.comparing()) this.closeCompare();
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
    // The last hire on an opening that states how many it needs closes it —
    // said here, because otherwise the opening just vanishes from the public
    // list with nothing on this screen explaining why.
    this.showToast(res.postingClosed
      ? name + ' → Hired. That fills every opening, so this posting is now closed to new applicants.'
      : name + ' → ' + STATUS_LABELS[next] + '. They’ll see it on their dashboard.');
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
      'Meets education', 'Degree in the field', 'Meets experience', 'Months experience', 'Related months',
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
      // Blank, not "No", where field relevance does not apply to this opening.
      r.eduFieldRelated === null || r.eduFieldRelated === undefined ? '' : (r.eduFieldRelated ? 'Yes' : 'No'),
      r.expMeets ? 'Yes' : 'No',
      r.seekerMonths,
      r.relevantMonths ?? '',
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
