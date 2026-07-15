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
   ResumeMatch PH — Onboarding tour. Direct port of
   04_Website/app/assets/tutorial.js. Runs automatically the first
   time a person lands on a page, and is replayable forever from the
   "Show me around" button. Steps whose target isn't on screen are
   skipped silently.
   ============================================================ */
@Injectable({ providedIn: 'root' })
export class TourService {
  private key = '';
  private steps: TourStep[] = [];
  private i = 0;
  private open = false;
  private opts: TourOpts = {};
  private timer: any = null;
  private els: { spot: HTMLElement; card: HTMLElement } | null = null;
  private lastFocus: HTMLElement | null = null;
  private onKeyBound = (e: KeyboardEvent) => this.onKey(e);
  private onMoveBound = () => { if (this.open) this.place(); };

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

  private place(): void {
    const steps = this.visible();
    if (!steps.length) { this.finish(true); return; }
    if (this.i >= steps.length) this.i = steps.length - 1;
    if (this.i < 0) this.i = 0;

    const step = steps[this.i];
    const el = document.querySelector(step.sel) as HTMLElement;
    const { spot, card } = this.els!;

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });

    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const r = el.getBoundingClientRect();
      spot.style.top = r.top - 6 + 'px';
      spot.style.left = r.left - 6 + 'px';
      spot.style.width = r.width + 12 + 'px';
      spot.style.height = r.height + 12 + 'px';

      const last = this.i === steps.length - 1;
      card.innerHTML =
        '<h4></h4><p></p>' +
        '<div class="tour-foot">' +
          '<span class="tour-count">Step ' + (this.i + 1) + ' of ' + steps.length + '</span>' +
          '<span class="tour-btns">' +
            '<button class="btn ghost sm" data-skip type="button">Skip</button>' +
            (this.i > 0 ? '<button class="btn ghost sm" data-back type="button">Back</button>' : '') +
            '<button class="btn primary sm" data-next type="button">' + (last ? 'Done' : 'Next') + '</button>' +
          '</span>' +
        '</div>';
      card.querySelector('h4')!.textContent = step.title;
      card.querySelector('p')!.textContent = step.text;

      card.querySelector('[data-next]')!.addEventListener('click', () => (last ? this.finish(true) : (this.i++, this.place())));
      card.querySelector('[data-skip]')!.addEventListener('click', () => this.finish(true));
      const back = card.querySelector('[data-back]');
      if (back) back.addEventListener('click', () => { this.i--; this.place(); });

      // below the target if it fits, otherwise above; always inside the viewport
      const ch = card.offsetHeight, cw = card.offsetWidth, pad = 14;
      let top = r.bottom + pad;
      if (top + ch > window.innerHeight - 12) top = r.top - ch - pad;
      if (top < 12) top = Math.min(window.innerHeight - ch - 12, Math.max(12, r.bottom + pad));
      const left = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
      card.style.top = top + 'px';
      card.style.left = left + 'px';

      (card.querySelector('[data-next]') as HTMLElement).focus({ preventScroll: true });
    }, 260);
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
    this.place();
  }

  private finish(remember: boolean): void {
    if (!this.open) return;
    clearTimeout(this.timer);
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
