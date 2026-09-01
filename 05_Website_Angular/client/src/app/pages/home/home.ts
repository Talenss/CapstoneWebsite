import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { WEIGHTS } from '../../core/engine';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';

/** Port of the PHP index.html — the landing page.
 *
 *  One API call, and it is deliberate. The page used to print a row of round
 *  numbers under the hero, one of which was "7 open roles" typed into the
 *  markup — wrong the moment Clark Outsourcing posted an eighth, and nothing
 *  in the build would have noticed. The count now comes from the same endpoint
 *  the openings page reads, so it follows a recruiter opening a role, closing
 *  one, or letting a deadline lapse, with nothing to remember to update. */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home implements OnInit {
  /** Read, never restated. The weights are rows in match_settings, so an
   *  admin can retune them without a redeploy; prose that hardcoded the split
   *  would keep publishing the old numbers after they changed. */
  readonly WEIGHTS = WEIGHTS;
  private api = inject(ApiService);

  /** null until the request answers, which is not the same as zero: an
   *  unreachable server must not tell a visitor there are no jobs. */
  openCount = signal<number | null>(null);

  async ngOnInit(): Promise<void> {
    const res = await this.api.postings.open();
    if (res.ok) this.openCount.set(res.postings.length);
  }

  /** The button says what clicking it will get you. It falls back to the
   *  plain label while the count is unknown, and when there is genuinely
   *  nothing open — "See all 0 openings" is a worse door than "See the
   *  openings", and the openings page explains an empty list properly. */
  openingsLabel = computed(() => {
    const n = this.openCount();
    if (n === null || n === 0) return 'See the openings';
    return n === 1 ? 'See the one opening' : `See all ${n} openings`;
  });

  /** The same fact as a sentence, for the partner section. Empty when there
   *  is nothing to state, so the paragraph simply is not rendered. */
  openingsLine = computed(() => {
    const n = this.openCount();
    if (n === null || n === 0) return '';
    return n === 1
      ? 'One position is accepting applications right now.'
      : `${n} positions are accepting applications right now.`;
  });
}
