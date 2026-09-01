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
}
