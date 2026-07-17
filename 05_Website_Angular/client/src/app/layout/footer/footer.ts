import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Port of the <footer class="footer"> block. `full` renders the four-column
 *  footer used on the landing page; otherwise a minimal copyright bar,
 *  matching learning-hub/privacy/404. Most authenticated pages have no footer
 *  at all in the original and simply omit this component. */
@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './footer.html',
  styleUrl: './footer.css',
})
export class Footer {
  full = input(false);
  year = new Date().getFullYear();
}
