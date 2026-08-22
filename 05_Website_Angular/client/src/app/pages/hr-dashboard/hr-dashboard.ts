import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { TourService } from '../../shared/tour/tour.service';
import { HrStats, Posting } from '../../core/models';
import { STATUS_LABELS, STATUS_ORDER } from '../../core/engine';

/** Port of 04_Website/app/hr-dashboard.html — the recruiter's home: a stat
 *  tally, the five-stage pipeline funnel, and the list of their own
 *  openings with review/edit/close-reopen actions. */
@Component({
  selector: 'app-hr-dashboard',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './hr-dashboard.html',
  styleUrl: './hr-dashboard.css',
})
export class HrDashboard implements OnInit {
  private api = inject(ApiService);
  private tour = inject(TourService);
  session = inject(SessionService);

  readonly statusOrder = STATUS_ORDER;
  readonly statusLabels = STATUS_LABELS;

  stats = signal<HrStats | null>(null);
  postings = signal<Posting[]>([]);
  loading = signal(true);
  coLabel = signal('');
  toastMsg = signal<string | null>(null);

  /* ---- finding an opening ----
     The applicant's side has had search, a department filter and a sort
     since it was built; the recruiter's own list had none of it and was
     stuck in insertion order, so a company running two dozen vacancies had
     to read the whole page to find one. The same three controls, plus the
     one filter only this side needs: open vs closed. */
  query = signal('');
  state = signal<'' | 'open' | 'closed' | 'expired' | 'waiting'>('');
  sort = signal<'new' | 'applicants' | 'az'>('new');

  visiblePostings = computed<Posting[]>(() => {
    const q = this.query().trim().toLowerCase();
    const state = this.state();

    let out = this.postings().filter((p) => {
      // "Deadline passed" is a state of its own on this page — an opening
      // still marked open that no longer accepts anyone. Rolling it into
      // "open" would hide exactly the rows that need attention.
      if (state === 'open' && !(p.status === 'open' && !p.expired)) return false;
      if (state === 'closed' && p.status !== 'closed') return false;
      if (state === 'expired' && !(p.status === 'open' && p.expired)) return false;
      if (state === 'waiting' && !p.newCount) return false;
      if (!q) return true;
      return (p.title + ' ' + p.department + ' ' + p.skills.join(' ')).toLowerCase().includes(q);
    });

    const by = this.sort();
    out = [...out].sort((a, b) =>
      by === 'az' ? a.title.localeCompare(b.title)
        : by === 'applicants' ? (b.applicantCount ?? 0) - (a.applicantCount ?? 0)
          : b.createdAt - a.createdAt);
    return out;
  });

  onQueryInput(e: Event): void { this.query.set((e.target as HTMLInputElement).value); }
  onStateChange(e: Event): void { this.state.set((e.target as HTMLSelectElement).value as any); }
  onSortChange(e: Event): void { this.sort.set((e.target as HTMLSelectElement).value as any); }

  clearFilters(): void {
    this.query.set('');
    this.state.set('');
    this.sort.set('new');
  }

  hello = computed(() => {
    const u = this.session.user();
    return u ? 'Good day, ' + u.name.split(' ')[0] + '.' : 'Good day.';
  });

  async ngOnInit(): Promise<void> {
    const user = this.session.user();
    if (user?.companyId) {
      const co = await this.api.companies.get(user.companyId);
      if (co.ok) this.coLabel.set(co.company.name + ' · ' + (user.position || 'HR'));
    }
    await this.render();

    this.tour.init(
      'hr-dashboard',
      [
        { sel: '#tally', title: 'Where things stand', text: `"Waiting for you" is the number that matters. Those are applications nobody has opened yet.` },
        { sel: '#pipe', title: 'Nobody drops off silently', text: `Every applicant sits in one of these five stages. The system never moves anyone between them. You do, and it’s recorded.` },
        { sel: '#postSection', title: 'Your openings', text: `Each row shows how many people applied. Closing an opening stops new applications but keeps everyone you already have.` },
        { sel: '.p-row .btn.primary', title: 'The ranked list', text: `This is the core of it: applicants sorted by compatibility, with the score broken down. And both their structured resume and their own uploaded file.` },
      ],
      { user: user?.id },
    );
  }

  private async render(): Promise<void> {
    this.loading.set(true);
    const [sRes, pRes] = await Promise.all([this.api.stats.hr(), this.api.postings.mine()]);
    if (sRes.ok) this.stats.set(sRes.stats);
    this.postings.set(pRes.ok ? pRes.postings : []);
    this.loading.set(false);
  }

  day(ts: number): string {
    return new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  }

  async toggle(p: Posting): Promise<void> {
    const r = await this.api.postings.toggle(p.id);
    if (!r.ok) { this.showToast(r.error); return; }
    await this.render();
    this.showToast(p.title + ' is now ' + r.posting.status + '.');
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
