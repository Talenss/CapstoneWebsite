import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { environment } from '../../../environments/environment';

/** Researcher-facing aggregates for the study's evaluation chapter —
 *  score distributions, tier counts at application time, the status
 *  funnel, and recruiter responsiveness. Anonymous by construction:
 *  counts and durations, never a name. Exportable as CSV for the
 *  spreadsheet the evaluation chapter is written in, or as JSON when the
 *  nested structure matters. */
@Component({
  selector: 'app-admin-metrics',
  standalone: true,
  imports: [Header, Footer],
  templateUrl: './admin-metrics.html',
  styleUrl: './admin-metrics.css',
})
export class AdminMetrics implements OnInit {
  /** "Oct 6, 2026, 9:25 AM", not an ISO timestamp. */
  stamp(iso: string | null | undefined): string {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d.getTime()) ? d.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  }

  private api = inject(ApiService);

  isDemo = environment.mode === 'demo';
  loaded = signal(false);
  m = signal<any | null>(null);
  errorMsg = signal('');

  maxBucket = computed(() => {
    const b = this.m()?.scores?.buckets ?? [];
    return Math.max(1, ...b.map((x: any) => x.count));
  });

  funnelRows = computed(() => {
    const f = this.m()?.funnel ?? {};
    const labels: Record<string, string> = {
      submitted: 'Submitted', review: 'Under review', shortlisted: 'Shortlisted', rejected: 'Not selected', hired: 'Hired',
    };
    const max = Math.max(1, ...Object.values(f).map((n: any) => Number(n)));
    return ['submitted', 'review', 'shortlisted', 'rejected', 'hired'].map((k) => ({
      key: k, label: labels[k], count: Number(f[k] || 0), pct: (Number(f[k] || 0) / max) * 100,
    }));
  });

  tierRows = computed(() => {
    const t = this.m()?.tiersAtApplication ?? {};
    const total = Math.max(1, Number(t.strong || 0) + Number(t.possible || 0) + Number(t.related || 0));
    return [
      { label: 'Strong match', cls: 'green', count: Number(t.strong || 0), pct: (Number(t.strong || 0) / total) * 100 },
      { label: 'Possible match', cls: 'amber', count: Number(t.possible || 0), pct: (Number(t.possible || 0) / total) * 100 },
      { label: 'Related (below threshold, applied anyway)', cls: 'slate', count: Number(t.related || 0), pct: (Number(t.related || 0) / total) * 100 },
    ];
  });

  async ngOnInit(): Promise<void> {
    const res = await this.api.metrics.summary();
    if (res.ok) this.m.set(res.metrics);
    else this.errorMsg.set(res.error);
    this.loaded.set(true);
  }

  downloadJson(): void {
    const data = this.m();
    if (!data) return;
    this.save(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      `linaw-metrics-${this.today()}.json`,
    );
  }

  /** The same numbers as a spreadsheet. JSON is the honest export of a
   *  nested payload, but nobody writes an evaluation chapter out of JSON —
   *  the figures go into Excel or SPSS, and those read CSV. The nesting is
   *  flattened into long format (section, metric, value): one row per
   *  number, which is also the shape a pivot table wants. */
  downloadCsv(): void {
    const d = this.m();
    if (!d) return;

    const rows: (string | number)[][] = [['Section', 'Metric', 'Value']];
    rows.push(['Meta', 'Generated at', d.generatedAt]);
    rows.push(['Thresholds', 'Strong match at or above (%)', d.thresholds?.strong]);
    rows.push(['Thresholds', 'Possible match at or above (%); related role below it', d.thresholds?.related]);

    const vol: [string, unknown][] = [
      ['Job seekers', d.volumes?.seekers], ['Recruiters', d.volumes?.recruiters],
      ['Resumes built', d.volumes?.resumes], ['Postings', d.volumes?.postings],
      ['Postings still open', d.volumes?.openPostings], ['Applications', d.volumes?.applications],
      ['Saved openings', d.volumes?.savedJobs],
    ];
    for (const [k, v] of vol) rows.push(['Volumes', k, v as any]);

    // An average of nothing is blank, not 0 — the two mean different things
    // and a spreadsheet will happily average a fabricated zero.
    rows.push(['Scores', 'Average score at application (%)', d.scores?.average ?? '']);
    for (const b of d.scores?.buckets ?? []) rows.push(['Score distribution', b.range, b.count]);
    for (const t of this.tierRows()) rows.push(['Tier at application', t.label, t.count]);
    for (const f of this.funnelRows()) rows.push(['Status funnel', f.label, f.count]);
    rows.push(['Responsiveness', 'Applications decided', d.responsiveness?.applicationsDecided ?? 0]);
    rows.push(['Responsiveness', 'Average hours to first decision', d.responsiveness?.avgHoursToFirstDecision ?? '']);

    // A BOM so Excel reads it as UTF-8 — the tier labels carry an en dash.
    const csv = '﻿' + rows.map((r) => r.map((c) => this.csvCell(c)).join(',')).join('\r\n');
    this.save(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `linaw-metrics-${this.today()}.csv`);
  }

  private csvCell(v: unknown): string {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private save(blob: Blob, filename: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
