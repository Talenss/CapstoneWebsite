import { Location } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { DESIGN_ORDER, visibleResume, experienceInPrintOrder } from '../../core/engine';
import { Resume } from '../../core/models';

type SectionKind = 'education' | 'experience' | 'skills' | 'projects' | 'certifications';
type PaperSize = 'a4' | 'letter';
const PAPER_KEY = 'linaw_paper_size';

/** Port of the PHP resume-print.html — an ATS-friendly, one-column
 *  print sheet. No site header/footer here, just a bespoke toolbar with
 *  Back / Print buttons; the printable "sheet" pulls a single resume by
 *  the ?id= query param and lays out its sections in the order implied
 *  by the resume's chosen template. */
@Component({
  selector: 'app-resume-print',
  standalone: true,
  imports: [],
  templateUrl: './resume-print.html',
  styleUrl: './resume-print.css',
})
export class ResumePrint implements OnInit, OnDestroy {
  /** Jobs still held first, the order every screen prints them in. */
  readonly printOrder = experienceInPrintOrder;
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private location = inject(Location);
  private router = inject(Router);
  private session = inject(SessionService);

  loading = signal(true);
  error = signal<string | null>(null);
  resume = signal<Resume | null>(null);

  /** A4 by default; the choice sticks so the next print doesn't need it set
   *  again. Only the @page size changes — the layout itself is identical. */
  paper = signal<PaperSize>('a4');

  contactLine = computed(() => this.join(
    [this.resume()?.personal.email, this.resume()?.personal.phone, this.resume()?.personal.address], '  ·  '));
  linkLine = computed(() => this.join(
    [this.resume()?.personal.linkedin, this.resume()?.personal.portfolio], '  ·  '));
  languageLine = computed(() => (this.resume()?.languages ?? [])
    .map((l) => this.join([l.name, l.proficiency], ', ')).join('  ·  '));

  sectionOrder = computed<SectionKind[]>(() => {
    const r = this.resume();
    // 'graduate' and 'technical' are defined by the order they impose, so
    // they override the template — the same rule as the live preview.
    const forced = r ? DESIGN_ORDER[r.design] : undefined;
    if (forced) return forced as SectionKind[];
    const t = r?.template;
    if (t === 'functional') return ['skills', 'experience', 'education', 'projects', 'certifications'];
    if (t === 'combination') return ['skills', 'education', 'experience', 'projects', 'certifications'];
    return ['education', 'experience', 'skills', 'projects', 'certifications'];
  });

  async ngOnInit(): Promise<void> {
    // The role decides where Back leads when this sheet was opened in a tab
    // of its own, so the session has to be resolved even though the page
    // itself renders the same for everyone.
    void this.session.ensure();

    let saved: string | null = null;
    try { saved = localStorage.getItem(PAPER_KEY); } catch { /* private mode — A4 stands */ }
    this.setPaper(saved === 'letter' ? 'letter' : 'a4');

    const id = this.route.snapshot.queryParamMap.get('id');
    if (!id) {
      this.error.set('No resume selected.');
      this.loading.set(false);
      return;
    }
    const res = await this.api.resumes.get(id);
    this.loading.set(false);
    if (!res.ok) {
      this.error.set(res.error);
      return;
    }
    /* THE SHEET IS THE VISIBLE RESUME, never the stored one.
       A section the applicant switched off must not reach the document, and
       their private links must never reach it at all — they exist precisely
       so a URL stays off the printed page. Stripping here rather than in the
       template means no design, present or future, can print one by accident:
       the fourteen layouts render whatever object they are handed. */
    this.resume.set(visibleResume(res.resume));
    /* This becomes the suggested PDF FILENAME when the applicant saves, and
       the recruiter sees that filename on the attachment. It used to carry
       this site's name, so people were sending "Juan Dela Cruz — Linaw
       PH.pdf" to employers. The applicant's own name is what belongs there. */
    const who = res.resume.personal.fullName?.trim();
    document.title = who ? `${who} Resume` : 'Resume';
  }

  monthsLabel(months: number): string {
    return months ? `${months} month${months > 1 ? 's' : ''}` : '';
  }

  /** Joins the parts of a meta line, dropping empties. Template expressions
   *  can't reach the global `Boolean`, so this can't be inlined in the HTML. */
  join(parts: (string | undefined | null)[], sep = ' · '): string {
    return parts.map((x) => (x ?? '').trim()).filter((x) => x !== '').join(sep);
  }

  /** "Jun 2025 – Present". One date format throughout the sheet. */
  dateRange(e: { startDate?: string; endDate?: string; current?: boolean }): string {
    const from = (e.startDate || '').trim();
    const to = e.current ? 'Present' : (e.endDate || '').trim();
    if (from && to) return `${from} – ${to}`;
    return from || to || '';
  }

  setPaper(size: PaperSize): void {
    this.paper.set(size);
    this.applyPageSize(size);
    try { localStorage.setItem(PAPER_KEY, size); } catch { /* private mode — the default still works */ }
  }

  /** `@page { size: … }` cannot be selected by a class — the at-rule has no
   *  access to the document tree — so the chosen page is written into a style
   *  element of its own. Appended to <head>, it wins over the component's
   *  A4 default by document order. */
  private applyPageSize(size: PaperSize): void {
    const id = 'linaw-page-size';
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    /* margin:0 for the same reason as the stylesheet: the page margin is
       where the browser prints its own header and footer, which an applicant
       tracking system then reads as the resume's first line. The white space
       is supplied by .sheet's padding instead. */
    el.textContent = size === 'letter'
      ? '@media print{@page{size:Letter;margin:0}.sheet{padding:0.75in}}'
      : '@media print{@page{size:A4;margin:0}.sheet{padding:18mm}}';
  }

  ngOnDestroy(): void {
    // Leaving the tag behind would resize every other page's printout.
    document.getElementById('linaw-page-size')?.remove();
  }

  /** The sheet is usually opened in a NEW TAB — "PDF" on My resumes, "Export
   *  PDF" in the builder, and now "Open full resume" on the recruiter's
   *  screen — and a fresh tab has nothing to go back to, so the button did
   *  nothing at all on a page with no header and no other way out.
   *
   *  The fallback has to know WHO is reading. Sending everyone to /my-resumes
   *  worked for the applicant and stranded the recruiter, because that route
   *  is seeker-only: a recruiter arriving there is bounced straight out
   *  again. Each role now goes somewhere it is allowed to be. */
  back(): void {
    if (history.length > 1) { this.location.back(); return; }
    const role = this.session.user()?.role;
    this.router.navigateByUrl(
      role === 'recruiter' ? '/hr-dashboard' : role === 'admin' ? '/admin' : '/my-resumes',
    );
  }

  print(): void {
    window.print();
  }
}
