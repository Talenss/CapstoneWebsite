import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { WEIGHTS } from '../../core/engine';

/** Port of the PHP privacy.html. Static except the weighting, which is
 *  read rather than restated: the split lives in match_settings and an admin
 *  can retune it without a redeploy, and a privacy notice publishing numbers
 *  the system no longer uses is a disclosure that has gone quietly wrong. */
@Component({
  selector: 'app-privacy',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './privacy.html',
  styleUrl: './privacy.css',
})
export class Privacy {
  readonly WEIGHTS = WEIGHTS;

  /** Scroll the contents list to a section, WITHOUT letting the browser
   *  follow the href.
   *
   *  index.html carries <base href="/">, and a bare fragment resolves
   *  against the base rather than against the current URL. So a plain
   *  <a href="#rights"> on /privacy navigates to /#rights — the home page —
   *  and the notice the reader was part-way through is gone. Measured, not
   *  assumed: clicking one left the URL at /#rights with no <article> in the
   *  document at all.
   *
   *  The href names the page as well as the section (/privacy#rights, not
   *  #rights), so the link still reads as a link, still announces its
   *  target, and opened in a new tab or copied it lands on this section
   *  rather than on the home page. Only the default navigation is replaced,
   *  by the scroll it was meant to do. */
  jump(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
