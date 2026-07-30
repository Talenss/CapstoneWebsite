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
          this.tocLinks.forEach((l) => l.classList.toggle('on', this.fragmentOf(l) === id));
        });
      },
      { rootMargin: '-92px 0px -70% 0px' },
    );
    this.articles.forEach((a) => this.spy!.observe(a));
  }

  /** The section a TOC link points at.
   *
   *  These links used to be bare `href="#basics"`, and this compared the whole
   *  href against '#' + id. They are now routerLink + fragment (a bare
   *  fragment resolves against <base href>, which sent every one of them to
   *  the home page), so the rendered href reads '/learning-hub#basics' and
   *  that comparison could never match again — the highlight silently stopped
   *  working. Read the fragment itself and the two forms both work. */
  private fragmentOf(a: HTMLAnchorElement): string {
    const href = a.getAttribute('href') ?? '';
    const hash = href.indexOf('#');
    return hash === -1 ? '' : href.slice(hash + 1);
  }

  ngOnDestroy(): void {
    this.spy?.disconnect();
  }

  onSearch(event: Event): void {
    const q = (event.target as HTMLInputElement).value.trim().toLowerCase();
    let hits = 0;
    const shown = new Set<string>();
    this.articles.forEach((a) => {
      const show = !q || (a.textContent ?? '').toLowerCase().includes(q);
      a.hidden = !show;
      if (show) { hits++; shown.add(a.id); }
    });
    // The contents list has to follow the search. It used to stay complete
    // while the articles behind it were hidden, so it offered links to
    // sections that were not on the page and clicking one did nothing.
    this.tocLinks.forEach((l) => {
      const item = l.closest('li') ?? l;
      (item as HTMLElement).hidden = !shown.has(this.fragmentOf(l));
    });
    this.noMatches.set(hits === 0);
  }
}
