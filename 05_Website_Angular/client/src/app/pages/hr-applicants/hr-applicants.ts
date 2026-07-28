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

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
