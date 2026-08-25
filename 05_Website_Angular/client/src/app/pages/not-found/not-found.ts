import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { SessionService } from '../../core/session.service';

/** Port of the PHP 404.html */
@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './not-found.html',
})
export class NotFound {
  private session = inject(SessionService);

  /** "Back to home" means the caller's own home. Sending a signed-in person
   *  who mistyped a URL to the marketing page explains the site to somebody
   *  who already joined it; sending them to their dashboard puts them back
   *  where they were working. Same homeFor() as the header logo. */
  home = computed(() => this.session.homeFor(this.session.user()));
}
