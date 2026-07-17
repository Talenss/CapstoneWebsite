import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { SessionService } from '../../core/session.service';
import { WEIGHTS, THRESHOLDS } from '../../core/engine';

/** Port of 04_Website/app/learning-hub.html. The weights/thresholds copy in
 *  the "Reading your score" article is generated from the same WEIGHTS /
 *  THRESHOLDS constants the scoring engine uses, so this page can never
 *  drift from it — mirroring the original inline <script>'s intent.
 *  Search and TOC-highlighting are ported as imperative DOM code (scoped to
 *  this component's host element), matching the original's approach — this
 *  widget is inherently DOM-measurement-driven. */
@Component({
  selector: 'app-learning-hub',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './learning-hub.html',
  styleUrl: './learning-hub.css',
})
export class LearningHub implements OnInit, AfterViewInit, OnDestroy {
  private el = inject<ElementRef<HTMLElement>>(ElementRef);
  session = inject(SessionService);

  readonly W = WEIGHTS;
  readonly T = THRESHOLDS;

  noMatches = signal(false);

  private articles: HTMLElement[] = [];
  private tocLinks: HTMLAnchorElement[] = [];
  private spy?: IntersectionObserver;

  ngOnInit(): void {
    // populate session.user() so the recruiter-only CTA below can react to it
    void this.session.ensure();
  }

  ngAfterViewInit(): void {
    const root = this.el.nativeElement;
    this.articles = Array.from(root.querySelectorAll<HTMLElement>('article'));
    this.tocLinks = Array.from(root.querySelectorAll<HTMLAnchorElement>('.toc a'));

    this.spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const id = (en.target as HTMLElement).id;
          this.tocLinks.forEach((l) => l.classList.toggle('on', l.getAttribute('href') === '#' + id));
        });
      },
      { rootMargin: '-92px 0px -70% 0px' },
    );
    this.articles.forEach((a) => this.spy!.observe(a));
  }

  ngOnDestroy(): void {
    this.spy?.disconnect();
  }

  onSearch(event: Event): void {
    const q = (event.target as HTMLInputElement).value.trim().toLowerCase();
    let hits = 0;
    this.articles.forEach((a) => {
      const show = !q || (a.textContent ?? '').toLowerCase().includes(q);
      a.hidden = !show;
      if (show) hits++;
    });
    this.noMatches.set(hits === 0);
  }
}
