import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Header } from '../../layout/header/header';
import { ApiService } from '../../core/api.service';
import { environment } from '../../../environments/environment';

/** Researcher-facing aggregates for the study's evaluation chapter —
 *  score distributions, tier counts at application time, the status
 *  funnel, and recruiter responsiveness. Anonymous by construction:
 *  counts and durations, never a name. Exportable as JSON so the numbers
 *  drop straight into the paper. */
@Component({
  selector: 'app-admin-metrics',
  standalone: true,
  imports: [Header],
  templateUrl: './admin-metrics.html',
  styleUrl: './admin-metrics.css',
})
export class AdminMetrics implements OnInit {
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
      { label: 'Possible match', cls: 'gold', count: Number(t.possible || 0), pct: (Number(t.possible || 0) / total) * 100 },
      { label: 'Related (below threshold — applied anyway)', cls: 'slate', count: Number(t.related || 0), pct: (Number(t.related || 0) / total) * 100 },
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
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `resumematch-metrics-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
