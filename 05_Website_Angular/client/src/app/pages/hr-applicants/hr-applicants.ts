import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl, SafeUrl } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { AppStatus, Personal, Posting, RankedRow, Tier } from '../../core/models';
import { EDU_LABELS, STATUS_LABELS, STATUS_ORDER, WEIGHTS, statusBadge, tierColor, tierLabel } from '../../core/engine';
import { FocusTrapDirective } from '../../shared/focus-trap.directive';

/** Port of 04_Website/app/hr-applicants.html — the ranked-applicant list
 *  for a single posting (?id=), with a search/filter bar and a dual-resume
 *  detail modal: the structured (scored) resume next to the applicant's
 *  own uploaded file (never scored). */
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
  fStatus = signal('');
  fTier = signal('');
  fFile = signal('');

  current = signal<RankedRow | null>(null);
  modalStatus = signal<AppStatus>('submitted');
  savingStatus = signal(false);

  // ---- message the applicant (interview invite) ----
  inviteOpen = signal(false);
  inviteText = signal('');
  inviteSending = signal(false);

  openInvite(): void {
    const r = this.current();
    if (!r) return;
    const first = (r.seeker.name || '').split(' ')[0] || r.seeker.name;
    this.inviteText.set(
      `Hi ${first},\n\nThank you for applying to ${this.posting()?.title ?? 'our opening'}. We'd like to invite you to an interview. Could you tell us which days and times work for you this coming week?\n\nWe look forward to meeting you.`,
    );
    this.inviteOpen.set(true);
  }

  setInviteText(e: Event): void {
    this.inviteText.set((e.target as HTMLTextAreaElement).value);
  }

  async sendInvite(): Promise<void> {
    const r = this.current();
    if (!r) return;
    this.inviteSending.set(true);
    const res = await this.api.applications.invite(r.application.id, this.inviteText().trim());
    this.inviteSending.set(false);
    if (!res.ok) { this.showToast(res.error); return; }
    this.inviteOpen.set(false);
    this.showToast(res.simulated
      ? `Demo mode — in the real system this message is emailed to ${r.seeker.name}, with replies going to your inbox.`
      : `Message emailed to ${r.seeker.name}. Their reply will land in your inbox.`);
  }

  toastMsg = signal<string | null>(null);

  /** Shown only on the printed sheet, so a page found on a desk later can be
   *  dated. Fixed at load rather than computed per render — a value that
   *  changes during change detection would be a needless re-render. */
  readonly printedOn = new Date().toLocaleDateString('en-PH', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  filteredRows = computed(() => {
    const q = this.q().trim().toLowerCase();
    const fs = this.fStatus();
    const ft = this.fTier();
    const ff = this.fFile();
    return this.rows().filter((r) => {
      if (fs && r.application.status !== fs) return false;
      if (ft && r.tier !== ft) return false;
      if (ff === 'yes' && !r.resume.ownFile) return false;
      if (ff === 'no' && r.resume.ownFile) return false;
      if (!q) return true;
      return (r.seeker.name + ' ' + (r.resume.skills || []).join(' ')).toLowerCase().indexOf(q) !== -1;
    });
  });

  subLabel = computed(() => {
    const p = this.posting();
    if (!p) return '';
    const n = this.rows().length;
    return (
      n + ' applicant' + (n === 1 ? '' : 's') + ' · asking for ' +
      p.skills.join(', ') + ' · ' + EDU_LABELS[p.educationLevel].toLowerCase() +
      (p.minExperienceMonths ? ' · ' + p.minExperienceMonths + ' months experience' : ' · no experience required')
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

  private async load(id: string): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    const res = await this.api.applications.ranked(id);
    this.loading.set(false);
    if (!res.ok) { this.loadError.set(res.error); return; }
    this.posting.set(res.posting);
    this.rows.set(res.rows);
  }

  rank(r: RankedRow): number {
    return this.rows().indexOf(r) + 1;
  }

  day(ts: number): string {
    return new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  kb(n: number): string {
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }

  tierBadgeClass(t: Tier): string {
    return t === 'strong' ? 'green' : t === 'possible' ? 'gold' : 'slate';
  }

  contactLine(p: Personal): string {
    return [p.email, p.phone, p.address].filter(Boolean).join('  ·  ');
  }

  iframeUrl(resumeId: string | null): SafeResourceUrl | null {
    if (!resumeId) return null;
    const url = this.api.resumes.fileUrl(resumeId);
    return url ? this.sanitizer.bypassSecurityTrustResourceUrl(url) : null;
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

  setQuery(e: Event): void { this.q.set((e.target as HTMLInputElement).value); }
  setFStatus(e: Event): void { this.fStatus.set((e.target as HTMLSelectElement).value); }
  setFTier(e: Event): void { this.fTier.set((e.target as HTMLSelectElement).value); }
  setFFile(e: Event): void { this.fFile.set((e.target as HTMLSelectElement).value); }
  setModalStatus(e: Event): void { this.modalStatus.set((e.target as HTMLSelectElement).value as AppStatus); }

  openModal(r: RankedRow): void {
    this.current.set(r);
    this.modalStatus.set(r.application.status);
  }

  closeModal(): void {
    this.current.set(null);
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
    const res = await this.api.applications.setStatus(r.application.id, next);
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

  exportCsv(): void {
    const rows = this.filteredRows();
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
  printList(): void {
    window.print();
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
