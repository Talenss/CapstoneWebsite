import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Each page owns its own <app-header>/<app-footer> (variants differ too
 *  much across guest/seeker/recruiter/auth/print to share one app shell),
 *  so the root component is just the router outlet. */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}
