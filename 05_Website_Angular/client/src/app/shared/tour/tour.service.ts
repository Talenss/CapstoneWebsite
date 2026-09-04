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
   Linaw PH, Onboarding tour. Runs automatically the first
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
    return 'linaw_tour_' + this.key + (this.opts.user ? '_' + this.opts.user : '');
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

    // The spotlight sits 6px outside the target on every side, which on a
    // narrow phone put its right edge past the viewport: the card below is
    // clamped, the spotlight never was, and a position:fixed box wider than
    // the window scrolls the page sideways. Clamp the ring to the viewport
    // so it hugs the visible part of the target instead.
    const sl = Math.max(0, r.left - 6);
    const sr = Math.min(window.innerWidth, r.right + 6);
    const st = Math.max(0, r.top - 6);
    const sb = Math.min(window.innerHeight, r.bottom + 6);
    spot.style.top = st + 'px';
    spot.style.left = sl + 'px';
    spot.style.width = Math.max(0, sr - sl) + 'px';
    spot.style.height = Math.max(0, sb - st) + 'px';

    // Below the target if it fits, then above, then beside it — and never on
    // top of it. The old last resort clamped the card into the viewport
    // without checking what it landed on, so a wide short target with little
    // room either side (the recruiter dashboard's pipeline row, the builder's
    // step bar) got its explanation placed directly over the thing being
    // explained. A tour that hides its own subject teaches nothing.
    const ch = card.offsetHeight, cw = card.offsetWidth, pad = 14;
    const vw = window.innerWidth, vh = window.innerHeight, edge = 12;
    let top = r.bottom + pad;
    let left = Math.min(Math.max(edge, r.left), vw - cw - edge);

    if (top + ch > vh - edge) {
      const above = r.top - ch - pad;
      if (above >= edge) {
        top = above;
      } else {
        // No room above or below. Put it to whichever side has more space and
        // keep it vertically centred on the target.
        const roomRight = vw - r.right, roomLeft = r.left;
        top = Math.min(vh - ch - edge, Math.max(edge, r.top + r.height / 2 - ch / 2));
        left =
          roomRight >= cw + pad + edge || roomRight >= roomLeft
            ? Math.min(vw - cw - edge, r.right + pad)
            : Math.max(edge, r.left - cw - pad);
      }
    }

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

    // Mark it seen the moment it AUTO-opens, not only when it is finished.
    // Otherwise a person who navigates away mid-tour (an in-app link destroys
    // the page, and the next page's init() calls stop() → finish(false)) is
    // never recorded as having seen it, so the tour re-appears on every visit.
    // The requirement is that it shows once per page; recording it here is
    // what makes that true. The "Show me around" button calls start(true),
    // which skips this whole block, so replay is unaffected.
    if (!force) { try { localStorage.setItem(this.seenKey(), '1'); } catch { /* ignore */ } }

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
