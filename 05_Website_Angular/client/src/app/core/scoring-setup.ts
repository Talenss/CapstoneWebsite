import { Injectable, signal } from '@angular/core';

/** When the browser's scoring engine last took on data from the server.
 *
 *  The job board, the posting form's preview and the applicant's "could
 *  reach" figure all score in the browser, with the same engine the server
 *  uses. Two things it needs arrive after the page has started: the scoring
 *  weights and the skill dictionary (the admins' linked synonyms). Both are
 *  fetched without holding the page up, which is right, but a page that had
 *  already worked out its scores kept them: if the dictionary landed late,
 *  the board went on showing, say, 75% for an opening the server scores at
 *  100%, until the page was reloaded.
 *
 *  So anything that scores in the browser reads `version()`, and whatever
 *  loads that data calls `bump()`. The scores are then worked out again the
 *  moment it lands, however late, and nothing has to wait for it. */
@Injectable({ providedIn: 'root' })
export class ScoringSetup {
  readonly version = signal(0);
  bump(): void { this.version.update((v) => v + 1); }
}
