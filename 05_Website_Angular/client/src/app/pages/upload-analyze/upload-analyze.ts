import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { AnalysisService } from '../../core/analysis.service';
import { AnalyzedResume } from '../../core/models';
import { ALLOWED_MIME, MAX_UPLOAD, WEIGHTS} from '../../core/engine';

/** The "Upload & analyze my resume" page — the opt-in AI path.
 *
 *  The user explicitly submits a resume file for analysis; the system
 *  extracts its content (Gemini in server mode, simulated in demo mode)
 *  and shows what it found. Nothing is saved here: the extraction is
 *  handed to the builder for the user to review, edit, and save — and
 *  from there the existing rule-based engine scores it like any other
 *  resume. The original file is kept so it can be attached to the saved
 *  resume for recruiters to read, same as the dual-resume model.
 */
@Component({
  selector: 'app-upload-analyze',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './upload-analyze.html',
  styleUrl: './upload-analyze.css',
})
export class UploadAnalyze implements OnInit {
  /** Read, never restated. The weights are rows in match_settings, so an
   *  admin can retune them without a redeploy; prose that hardcoded the split
   *  would keep publishing the old numbers after they changed. */
  readonly WEIGHTS = WEIGHTS;
  private api = inject(ApiService);
  private analysis = inject(AnalysisService);
  private router = inject(Router);

  /* WHICH reader will run, resolved before consent is asked for.
   *
   * The consent wording is chosen from this. RA 10173 requires consent to be
   * informed, and the informing has to happen where the person consents — not
   * on a privacy page they may never open. "The system's analysis service" is
   * true of the rule-based reader and materially understates Gemini, which
   * sends the document to a company outside the country. One checkbox cannot
   * honestly cover both, so the page asks the server which one is configured
   * and says that.
   *
   * `null` means the question has not been answered yet, and the page refuses
   * consent until it is. Guessing in either direction produces a false notice. */
  reader = signal<'rules' | 'gemini' | 'demo' | null>(null);

  consented = signal(false);

  async ngOnInit(): Promise<void> {
    const r = await this.api.analyze.reader();
    if (r.ok) this.reader.set(r.reader);
  }
  file = signal<File | null>(null);
  busy = signal(false);
  errorMsg = signal<string | null>(null);
  result = signal<AnalyzedResume | null>(null);
  simulated = signal(false);

  onFileChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    input.value = '';
    this.errorMsg.set(null);
    this.result.set(null);
    if (!f) return;
    if (f.size > MAX_UPLOAD) {
      this.errorMsg.set('That file is larger than 2 MB. Save it at a smaller size and try again.');
      return;
    }
    if (!ALLOWED_MIME.includes(f.type)) {
      this.errorMsg.set('Upload a PDF, Word document, or image (JPG or PNG).');
      return;
    }
    this.file.set(f);
  }

  clearFile(): void {
    this.file.set(null);
    this.result.set(null);
    this.errorMsg.set(null);
  }

  async analyzeNow(): Promise<void> {
    const f = this.file();
    if (!f || !this.consented() || this.busy()) return;
    this.busy.set(true);
    this.errorMsg.set(null);
    const res = await this.api.analyze.resume(f);
    this.busy.set(false);
    if (!res.ok) {
      this.errorMsg.set(res.error);
      return;
    }
    this.result.set(res.resume);
    this.simulated.set(!!res.simulated);
  }

  reviewInBuilder(): void {
    const data = this.result();
    if (!data) return;
    this.analysis.set({ data, file: this.file(), simulated: this.simulated() });
    this.router.navigate(['/resume-builder'], { queryParams: { from: 'analysis' } });
  }

  kb(n: number): string {
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }

  monthsLabel(m: number): string {
    return m === 1 ? '1 month' : `${m} months`;
  }

  /** Joins the parts of a line, dropping the empty ones. Template
   *  expressions can't reach the global `Boolean`, so it lives here. */
  join(parts: (string | undefined | null)[], sep = ' · '): string {
    return parts.map((x) => (x ?? '').trim()).filter((x) => x !== '').join(sep);
  }

  languageLine(): string {
    return (this.result()?.languages ?? [])
      .map((l) => this.join([l.name, l.proficiency], ', ')).join('  ·  ');
  }
}
