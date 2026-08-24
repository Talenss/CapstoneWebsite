import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { SessionService } from '../../core/session.service';
import { ApiService } from '../../core/api.service';
import { WEIGHTS, THRESHOLDS } from '../../core/engine';
import { Seo } from '../../core/seo';

/** Port of the PHP learning-hub.html. The weights/thresholds copy in
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
  private seo = inject(Seo);
  private api = inject(ApiService);
  session = inject(SessionService);

  /* WHAT EMPLOYERS HERE ASK FOR — a tally of open postings, read live rather
     than written into the article, so the page cannot claim a demand that the
     openings no longer show. It is public data: every one of these postings is
     readable without an account, and the count is not compared against
     anybody's resume. */
  demandRows = signal<{ name: string; n: number }[]>([]);
  openCount = signal(0);

  readonly W = WEIGHTS;
  readonly T = THRESHOLDS;

  noMatches = signal(false);

  private articles: HTMLElement[] = [];
  private tocLinks: HTMLAnchorElement[] = [];
  private spy?: IntersectionObserver;

  ngOnInit(): void {
    // populate session.user() so the recruiter-only CTA below can react to it
    void this.session.ensure();
    void this.loadDemand();

    /* This page is the site's one genuinely searchable asset: people look up
       "what is an ATS", "resume with no experience" and "resume skills
       section" in numbers, whereas nobody searches for a capstone project by
       name. The FAQ block is what can put those answers in the results page
       itself.

       Every answer below is a condensed version of what the article beside
       it already says. None of them adds a claim the page does not make —
       an FAQ block answering something the page does not answer is both a
       policy violation and a promise broken to whoever clicked. */
    this.seo.faq([
      {
        q: 'What is an ATS, and why does it matter for my resume?',
        a: 'An Applicant Tracking System is software that reads your resume before a person does. Most medium '
          + 'and large employers in the Philippines run applications through it first: it pulls the text out of '
          + 'your file, looks for the skills and qualifications named in the job posting, and ranks you. If it '
          + 'cannot read your file properly, a person may never see it.',
      },
      {
        q: 'How do I write the skills section of my resume?',
        a: 'Name specific, checkable skills rather than vague phrases. "JavaScript", "Customer Service", '
          + '"Bookkeeping" and "Data Entry" are matched against a posting\'s requirements; "computer skills" '
          + 'and "hardworking" match nothing. On ResumeMatch PH this section alone is half of your '
          + 'compatibility score by default, and more on openings that weight skills harder.',
      },
      {
        q: 'What do I put on a resume when I have no work experience?',
        a: 'Usually you have more than you think, because "no experience" normally means "no full-time job '
          + 'yet". OJT and internships count, including unpaid ones. So do your capstone or thesis project if '
          + 'you built something, part-time or seasonal work even when unrelated, and officer roles in an '
          + 'organisation.',
      },
      {
        q: 'What resume template should I use, chronological, functional or combination?',
        a: 'Chronological puts your history first and suits you when your education and experience already '
          + 'point at the role you want. Functional puts skills first and suits a change of direction or a '
          + 'gap. Combination leads with a short skills summary and then the history.',
      },
      {
        q: 'How is my compatibility score calculated?',
        a: 'From three checks against what the posting actually asks for: the skills you list, your education '
          + 'level, and your months of experience. How much each is worth is set per opening, most use the '
          + 'site default of 50 percent skills, 25 percent education and 25 percent experience, and a recruiter '
          + 'can weight a particular role differently. Whatever an opening uses is shown on the opening itself, '
          + 'and no criterion can be worth less than 10 percent.',
      },
      {
        q: 'Does a low compatibility score mean I am rejected?',
        a: 'No. Nothing on ResumeMatch PH is auto-rejected. A low score means the posting asks for things your '
          + 'resume does not yet show, and you are pointed toward a role that fits better. Every application '
          + 'reaches a recruiter, and a person sets every status.',
      },
    ]);
    this.seo.breadcrumbs([
      { name: 'Home', path: '/' },
      { name: 'Learning hub', path: '/learning-hub' },
    ]);
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
    // Leaving this page's FAQ behind would describe whatever comes next as
    // answering questions it does not answer.
    this.seo.faq([]);
    this.seo.breadcrumbs([]);
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

  /** Tally every open posting's required skills. Ordered by count here —
   *  unlike the builder's pool, which is alphabetical — because ordering is
   *  the entire point of an article about where the demand is, and there is
   *  no add button on this page to turn that order into a shortcut. */
  private async loadDemand(): Promise<void> {
    const res = await this.api.postings.open();
    if (!res.ok) return;
    const tally: Record<string, number> = {};
    for (const p of res.postings) for (const s of p.skills) tally[s] = (tally[s] || 0) + 1;
    this.openCount.set(res.postings.length);
    this.demandRows.set(
      Object.entries(tally)
        .map(([name, n]) => ({ name, n }))
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
    );
  }

}
