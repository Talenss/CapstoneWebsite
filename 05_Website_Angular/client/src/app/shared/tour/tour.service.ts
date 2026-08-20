import { Injectable } from '@angular/core';

export interface TourStep {
  sel: string;
  title: string;
  text: string;
}
export interface TourOpts {
  user?: string;
  auto?: boolean;
}

/* ============================================================
   ResumeMatch PH, Onboarding tour. Runs automatically the first
   time a person lands on a page, and is replayable forever from the
   "Show me around" button. Steps whose target isn't on screen are
   skipped silently.

   Movement is deliberately consistent: on every step the spotlight
   and the card are positioned together from the same measurement,
   and while the page smooth-scrolls to the target they are tracked
   in lockstep via requestAnimationFrame, so the speed never depends
   on how far apart two steps happen to be.
   ============================================================ */
@Injectable({ providedIn: 'root' })
export class TourService {
  private key = '';
  private steps: TourStep[] = [];
  private i = 0;
  private open = false;
  private opts: TourOpts = {};
  private raf = 0;
  private currentSel = '';
  private els: { spot: HTMLElement; card: HTMLElement } | null = null;
  private lastFocus: HTMLElement | null = null;
  private onKeyBound = (e: KeyboardEvent) => this.onKey(e);
  private onMoveBound = () => this.syncToCurrent();

  private seenKey(): string {
    return 'rmph_tour_' + this.key + (this.opts.user ? '_' + this.opts.user : '');
  }
  private visible(): TourStep[] {
    return this.steps.filter((s) => {
      const el = document.querySelector(s.sel) as HTMLElement | null;
      return el && el.offsetParent !== null; // exists AND is actually rendered
    });
  }

  private build(): void {
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    const card = document.createElement('div');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Tour');
    document.body.appendChild(spot);
    document.body.appendChild(card);
    this.els = { spot, card };
  }

  /** Move to the current step: render the card once, scroll the target
   *  into view, then track it until the scroll settles. */
  private show(): void {
    const steps = this.visible();
    if (!steps.length) { this.finish(true); return; }
    this.i = Math.max(0, Math.min(this.i, steps.length - 1));

    const step = steps[this.i];
    const el = document.querySelector(step.sel) as HTMLElement | null;
    if (!el) { this.finish(true); return; }
    this.currentSel = step.sel;

    this.render(step, steps.length);
    this.reposition(el);                                       // place immediately
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.follow(el);                                           // then track the scroll
  }

  /** Build the card's contents. Runs once per step change, never on
   *  scroll. So focus and button handlers stay stable. */
  private render(step: TourStep, total: number): void {
    const { card } = this.els!;
    const last = this.i === total - 1;
    card.innerHTML =
      '<h4></h4><p></p>' +
      '<div class="tour-foot">' +
        '<span class="tour-count">Step ' + (this.i + 1) + ' of ' + total + '</span>' +
        '<span class="tour-btns">' +
          '<button class="btn ghost sm" data-skip type="button">Skip</button>' +
          (this.i > 0 ? '<button class="btn ghost sm" data-back type="button">Back</button>' : '') +
          '<button class="btn primary sm" data-next type="button">' + (last ? 'Done' : 'Next') + '</button>' +
        '</span>' +
      '</div>';
    card.querySelector('h4')!.textContent = step.title;
    card.querySelector('p')!.textContent = step.text;

    card.querySelector('[data-next]')!.addEventListener('click', () => (last ? this.finish(true) : (this.i++, this.show())));
    card.querySelector('[data-skip]')!.addEventListener('click', () => this.finish(true));
    const back = card.querySelector('[data-back]');
    if (back) back.addEventListener('click', () => { this.i--; this.show(); });

    (card.querySelector('[data-next]') as HTMLElement).focus({ preventScroll: true });
  }

  /** Position the spotlight over `el` and the card beside it. Cheap and
   *  synchronous, safe to call every animation frame or scroll event. */
  private reposition(el: HTMLElement): void {
    if (!this.els) return;
    const { spot, card } = this.els;
    const r = el.getBoundingClientRect();

    spot.style.top = r.top - 6 + 'px';
    spot.style.left = r.left - 6 + 'px';
    spot.style.width = r.width + 12 + 'px';
    spot.style.height = r.height + 12 + 'px';

    // below the target if it fits, otherwise above; always inside the viewport
    const ch = card.offsetHeight, cw = card.offsetWidth, pad = 14;
    let top = r.bottom + pad;
    if (top + ch > window.innerHeight - 12) top = r.top - ch - pad;
    if (top < 12) top = Math.min(window.innerHeight - ch - 12, Math.max(12, r.bottom + pad));
    const left = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
    card.style.top = top + 'px';
    card.style.left = left + 'px';
  }

  /** Follow the target every frame until its position stops changing —
   *  this covers the smooth-scroll regardless of distance, so the overlay
   *  and card always arrive together at the same speed. */
  private follow(el: HTMLElement): void {
    cancelAnimationFrame(this.raf);
    let lastTop = NaN, stable = 0;
    const tick = () => {
      if (!this.open || !this.els) return;
      this.reposition(el);
      const top = el.getBoundingClientRect().top;
      if (Math.abs(top - lastTop) < 0.5) {
        if (++stable >= 4) { this.raf = 0; return; }   // settled, hand off to scroll/resize
      } else {
        stable = 0;
      }
      lastTop = top;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Scroll/resize after the step has settled: just keep the overlay glued
   *  to the current target. Never re-scrolls and never rebuilds the card. */
  private syncToCurrent(): void {
    if (!this.open || !this.currentSel) return;
    const el = document.querySelector(this.currentSel) as HTMLElement | null;
    if (el) this.reposition(el);
    else this.show(); // target left the DOM, recompute visible steps
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); this.finish(true); }
    else if (e.key === 'ArrowRight') { (this.els!.card.querySelector('[data-next]') as HTMLElement)?.click(); }
    else if (e.key === 'ArrowLeft') { (this.els!.card.querySelector('[data-back]') as HTMLElement)?.click(); }
    else if (e.key === 'Tab') { // keep focus inside the card
      const f = this.els!.card.querySelectorAll('button');
      if (!f.length) return;
      const first = f[0] as HTMLElement, last = f[f.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  start(force = false): void {
    if (this.open) return;
    if (!force) {
      try { if (localStorage.getItem(this.seenKey())) return; } catch { /* ignore */ }
    }
    if (!this.visible().length) return;

    this.lastFocus = document.activeElement as HTMLElement;
    this.open = true; this.i = 0;
    this.build();
    document.addEventListener('keydown', this.onKeyBound);
    window.addEventListener('resize', this.onMoveBound);
    window.addEventListener('scroll', this.onMoveBound, true);
    this.show();
  }

  private finish(remember: boolean): void {
    if (!this.open) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.els) { this.els.spot.remove(); this.els.card.remove(); this.els = null; }
    this.open = false;
    document.removeEventListener('keydown', this.onKeyBound);
    window.removeEventListener('resize', this.onMoveBound);
    window.removeEventListener('scroll', this.onMoveBound, true);
    if (remember) { try { localStorage.setItem(this.seenKey(), '1'); } catch { /* ignore */ } }
    if (this.lastFocus?.focus) this.lastFocus.focus();
  }

  stop(): void {
    this.finish(false);
  }

  /** Call once per page (e.g. in ngOnInit / ngAfterViewInit) after the page's
   *  DOM has rendered. Auto-starts on first visit unless opts.auto is false. */
  init(key: string, steps: TourStep[], opts: TourOpts = {}): void {
    this.stop();
    this.key = key; this.steps = steps || []; this.opts = opts || {};
    if (this.opts.auto !== false) setTimeout(() => this.start(false), 700); // first visit only
  }
}
