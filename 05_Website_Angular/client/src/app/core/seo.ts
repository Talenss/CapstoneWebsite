/* ============================================================
   ResumeMatch PH, core/seo.ts
   ------------------------------------------------------------
   Everything a search engine reads that is not visible on the
   page: the description, the canonical URL, the social cards, the
   robots directive, and the schema.org structured data.

   WHY A SERVICE AND NOT index.html
   index.html is one file shared by all eighteen routes. A single
   description there means /browse and /learning-hub are described
   to Google identically, and duplicate descriptions across a site
   are treated as a signal that the pages are duplicates. So the
   description, the canonical and the cards are set per route, from
   the `seo` block on each route's data.

   WHAT THIS DOES NOT DO
   This app is client-rendered: the HTML that arrives from the
   host is an empty <app-root>, and everything below is written by
   JavaScript afterwards. Google renders JavaScript and will see
   it; most other crawlers, and most social-media link previewers,
   will not. That is a real limit of the current architecture and
   it is stated in SETUP.md rather than hidden here.

   CSP NOTE
   The site ships `script-src 'self'`. A <script type="application/
   ld+json"> block is a DATA block, not executable script, and is
   not blocked by that policy, verified in Chromium against the
   exact CSP the deployed site sends, with no console violation.
   ============================================================ */
import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { environment } from '../../environments/environment';

/** What one route declares about itself. Everything is optional except the
 *  description, because a page with no description is one Google writes a
 *  description for out of whatever text it finds first. */
export interface SeoData {
  /** 140–160 characters. Shown under the title in results. */
  description: string;
  /** Overrides the route's `title` for social cards only, where the
   *  "— ResumeMatch PH" suffix is redundant next to the site name. */
  socialTitle?: string;
  /** false for anything behind a login: those pages have nothing a searcher
   *  can use, and indexing them wastes the crawl budget on redirects. */
  index?: boolean;
  /** 'website' for pages, 'article' for the learning hub. */
  ogType?: 'website' | 'article';
}

/** One opening, in the shape the JobPosting block needs. Kept separate from
 *  the app's own Posting model so core/seo.ts does not depend on it. */
export interface JobPostingInput {
  id: string;
  title: string;
  description: string;
  employmentType: string;
  skills: string[];
  postedAt: number;
  validThrough?: string | null;
  companyName: string;
  companyWebsite?: string | null;
  location?: string | null;
}

/** schema.org's employmentType vocabulary, which is not ours. */
const EMPLOYMENT: Record<string, string> = {
  'full-time': 'FULL_TIME',
  'part-time': 'PART_TIME',
  contract: 'CONTRACTOR',
  internship: 'INTERN',
};

/** A company's one free-text address line, split into the parts schema.org
 *  wants, and no further.
 *
 *  This replaced a hardcoded `addressLocality: 'Angeles City'`, which was
 *  wrong the moment it was written: the pilot partner's address ends
 *  "…Clark Freeport Zone, Mabalacat, 2023 Pampanga", so the block asserted
 *  one municipality while the street address beside it named another. The
 *  Clark Freeport Zone straddles both, and guessing which one a company sits
 *  in is not something a comma-splitter can do.
 *
 *  So the rule is: read the last two parts when the address is written the
 *  way Philippine addresses conventionally are, "…, Municipality, 1234
 *  Province". And when it is not, claim nothing beyond the country and the
 *  line itself. A missing addressLocality costs a little local relevance. A
 *  wrong one tells a job seeker the office is in a city it is not in. */
function addressOf(location: string | null | undefined) {
  const line = (location ?? '').trim();
  const base = { '@type': 'PostalAddress', addressCountry: 'PH' } as Record<string, string>;
  if (!line) return base;

  const parts = line.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return { ...base, streetAddress: line };

  const tail = parts[parts.length - 1];
  const locality = parts[parts.length - 2];
  const postal = (tail.match(/\b\d{4}\b/) || [''])[0];
  const region = tail.replace(/\b\d{4}\b/, '').trim();

  return {
    ...base,
    streetAddress: parts.slice(0, -2).join(', '),
    addressLocality: locality,
    ...(region ? { addressRegion: region } : {}),
    ...(postal ? { postalCode: postal } : {}),
  };
}

const SITE_NAME = 'ResumeMatch PH';
const DEFAULT_IMAGE = '/og-card.png';

@Injectable({ providedIn: 'root' })
export class Seo {
  private doc = inject(DOCUMENT);
  private meta = inject(Meta);
  private titleSvc = inject(Title);

  /** The site's own origin. Taken from the browser so it is correct on
   *  localhost, on a Vercel preview and on the final domain without anyone
   *  having to remember to change a constant, and overridable for the case
   *  where the same build is served from more than one host and only one of
   *  them should be the canonical one. */
  private origin(): string {
    const configured = (environment as { siteUrl?: string }).siteUrl;
    if (configured) return configured.replace(/\/$/, '');
    return this.doc.defaultView?.location.origin ?? '';
  }

  /** Called on every completed navigation. */
  apply(seo: SeoData | undefined, path: string): void {
    if (!seo) return;
    const url = this.origin() + (path === '/' ? '/' : path.replace(/\/$/, ''));
    const title = this.titleSvc.getTitle();
    const social = seo.socialTitle ?? title;
    const image = this.origin() + DEFAULT_IMAGE;

    this.meta.updateTag({ name: 'description', content: seo.description });

    /* A page that must not be indexed says so explicitly rather than relying
       on robots.txt. robots.txt stops the crawl, which also stops the crawler
       from ever seeing a noindex. So a page already in the index can be
       stuck there. The directive on the page is the one that removes it. */
    if (seo.index === false)
      this.meta.updateTag({ name: 'robots', content: 'noindex, nofollow' });
    else
      this.meta.updateTag({ name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1' });

    this.canonical(url);

    for (const [property, content] of [
      ['og:site_name', SITE_NAME],
      ['og:type', seo.ogType ?? 'website'],
      ['og:title', social],
      ['og:description', seo.description],
      ['og:url', url],
      ['og:image', image],
      ['og:locale', 'en_PH'],
    ]) this.meta.updateTag({ property, content });

    for (const [name, content] of [
      ['twitter:card', 'summary_large_image'],
      ['twitter:title', social],
      ['twitter:description', seo.description],
      ['twitter:image', image],
    ]) this.meta.updateTag({ name, content });
  }

  private canonical(url: string): void {
    let link = this.doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.doc.createElement('link');
      link.setAttribute('rel', 'canonical');
      this.doc.head.appendChild(link);
    }
    link.setAttribute('href', url);
  }

  /* ---------------- structured data ---------------- */

  /** Adds or replaces one JSON-LD block, keyed by id so a navigation cannot
   *  leave the previous page's structured data behind, describing the
   *  privacy notice as a job posting is worse than describing it as nothing. */
  jsonLd(id: string, data: unknown | null): void {
    const existing = this.doc.getElementById(id);
    if (existing) existing.remove();
    if (!data) return;
    const el = this.doc.createElement('script');
    el.id = id;
    el.type = 'application/ld+json';
    el.textContent = JSON.stringify(data);
    this.doc.head.appendChild(el);
  }

  /** schema.org JobPosting for a list of openings, the block that makes a
   *  listing eligible for the Google Jobs box, which is the single highest-
   *  leverage piece of structured data a job site can publish.
   *
   *  GATED, AND NOT BY ACCIDENT. Google's JobPosting policy requires the
   *  listings to be real vacancies, and to come down when they are filled.
   *  The openings in the demonstration build are seeded data for a capstone
   *  study. Publishing those would put jobs that do not exist in front of
   *  people in Angeles City who are actually looking for work, and would put
   *  the site at risk of a manual action for it. `publishJobPostings` stays
   *  false until the postings are real. */
  jobPostings(rows: JobPostingInput[]): void {
    if (!(environment as { publishJobPostings?: boolean }).publishJobPostings || !rows.length) {
      this.jsonLd('ld-jobs', null);
      return;
    }
    const origin = this.origin();
    this.jsonLd('ld-jobs', rows.map((r) => ({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: r.title,
      description: r.description,
      datePosted: new Date(r.postedAt).toISOString().slice(0, 10),
      ...(r.validThrough ? { validThrough: r.validThrough } : {}),
      employmentType: EMPLOYMENT[r.employmentType] ?? 'OTHER',
      /* Required by Google, and required to be accurate: identifier ties the
         listing to the posting a click actually lands on. */
      identifier: { '@type': 'PropertyValue', name: r.companyName, value: r.id },
      url: origin + '/browse',
      directApply: true,
      hiringOrganization: {
        '@type': 'Organization',
        name: r.companyName,
        ...(r.companyWebsite ? { sameAs: r.companyWebsite } : {}),
      },
      jobLocation: { '@type': 'Place', address: addressOf(r.location) },
      ...(r.skills.length ? { skills: r.skills.join(', ') } : {}),
      /* Deliberately absent: baseSalary. Google rewards it, and none of the
         postings state one. Inventing a range to earn the rich result would
         be telling a job seeker a number the employer never offered. */
    })));
  }

  /** FAQPage for the learning hub. Every question below is answered in full
   *  on the page itself. An FAQ block whose answers are not on the page is
   *  the most common way a site earns a structured-data manual action, and
   *  it would also mean promising a searcher an answer they then cannot
   *  find. The answers here are shortened from the article text, not
   *  invented alongside it. */
  faq(entries: { q: string; a: string }[]): void {
    this.jsonLd('ld-faq', entries.length ? {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: entries.map((e) => ({
        '@type': 'Question',
        name: e.q,
        acceptedAnswer: { '@type': 'Answer', text: e.a },
      })),
    } : null);
  }

  /** The trail shown under a result. Two levels only, because the site is
   *  two levels deep. */
  breadcrumbs(trail: { name: string; path: string }[]): void {
    const origin = this.origin();
    this.jsonLd('ld-crumbs', trail.length ? {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: trail.map((t, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: t.name,
        item: origin + t.path,
      })),
    } : null);
  }

  /** The two blocks that describe the site itself rather than a page. Set
   *  once, at startup, and never removed. */
  siteJsonLd(): void {
    const origin = this.origin();
    this.jsonLd('ld-site', {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          '@id': origin + '/#website',
          url: origin + '/',
          name: SITE_NAME,
          description: 'A free resume builder and rule-based job-matching platform for job seekers '
            + 'in Angeles City, Pampanga and the Clark Freeport Zone.',
          inLanguage: 'en-PH',
          publisher: { '@id': origin + '/#org' },
        },
        {
          /* Not a company. This is a student research project, and saying so
             in the structured data keeps it consistent with what the site
             says on every page, an organisation claim we cannot support is
             exactly the kind of thing that gets structured data distrusted. */
          '@type': 'EducationalOrganization',
          '@id': origin + '/#org',
          name: 'School of Computing, Holy Angel University',
          url: 'https://www.hau.edu.ph/',
          address: {
            '@type': 'PostalAddress',
            streetAddress: '#1 Holy Angel Avenue, Sto. Rosario',
            addressLocality: 'Angeles City',
            addressRegion: 'Pampanga',
            postalCode: '2009',
            addressCountry: 'PH',
          },
        },
      ],
    });
  }
}
