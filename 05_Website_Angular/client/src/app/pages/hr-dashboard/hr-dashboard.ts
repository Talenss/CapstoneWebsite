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
        { sel: '#tally', title: 'Where things stand', text: `"Waiting for you" is the number that matters — those are applications nobody has opened yet.` },
        { sel: '#pipe', title: 'Nobody drops off silently', text: `Every applicant sits in one of these five stages. The system never moves anyone between them. You do, and it’s recorded.` },
        { sel: '#postSection', title: 'Your openings', text: `Each row shows how many people applied. Closing an opening stops new applications but keeps everyone you already have.` },
        { sel: '.p-row .btn.primary', title: 'The ranked list', text: `This is the core of it: applicants sorted by compatibility, with the score broken down — and both their structured resume and their own uploaded file.` },
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
