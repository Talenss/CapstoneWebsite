import { Injectable } from '@angular/core';
import { AnalyzedResume } from './models';

export interface PendingAnalysis {
  data: AnalyzedResume;
  /** The original uploaded file, kept so the builder can attach it to the
   *  saved resume as the recruiter-visible "own file" (dual-resume model). */
  file: File | null;
  simulated: boolean;
}

/** Hands the AI extraction from the Upload & Analyze page to the resume
 *  builder. In-memory only, a page refresh simply drops the pending
 *  extraction (nothing was saved yet), which is the safe behavior. */
@Injectable({ providedIn: 'root' })
export class AnalysisService {
  private pending: PendingAnalysis | null = null;

  set(p: PendingAnalysis): void {
    this.pending = p;
  }

  /** Read and clear. The builder consumes the extraction exactly once. */
  take(): PendingAnalysis | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  has(): boolean {
    return this.pending !== null;
  }
}
