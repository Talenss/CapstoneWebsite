/* Linaw PH, shared/focus-trap.directive.ts

   Makes a modal usable with a keyboard and announceable by a screen reader.

   Before this, all three modals were visually correct and functionally
   broken for anyone not using a mouse: focus stayed on the button behind
   the overlay, Tab walked through the whole page underneath (11 of 14
   presses in a measured run landed outside), nothing identified the panel
   as a dialog, and closing dropped focus to <body> so a keyboard user lost
   their place entirely.

   Applied with [appFocusTrap] on the panel element. It:
     · marks the element as a dialog and labels it from its own heading
     · remembers what was focused, and moves focus inside on open
     · keeps Tab and Shift+Tab inside for as long as it is open
     · hides the rest of the page from assistive technology
     · restores focus to whatever opened it on close

   Deliberately dependency-free. The Angular CDK would bring a package for
   behaviour that is a few dozen lines here. */
import {
  Directive, ElementRef, OnDestroy, AfterViewInit, HostListener, inject,
} from '@angular/core';

/** Anything a keyboard can land on. :not([tabindex="-1"]) keeps out things
 *  that are focusable only programmatically. */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

@Directive({ selector: '[appFocusTrap]', standalone: true })
export class FocusTrapDirective implements AfterViewInit, OnDestroy {
  private host = inject(ElementRef<HTMLElement>);
  private previouslyFocused: HTMLElement | null = null;
  /** Siblings we hid from assistive technology, so we can restore exactly
   *  those and not clobber an aria-hidden someone else set. */
  private hidden: HTMLElement[] = [];

  ngAfterViewInit(): void {
    const el = this.host.nativeElement as HTMLElement;

    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');

    // Label the dialog from its own heading, so a screen reader announces
    // "Front Office Associate, dialog" rather than just "dialog".
    const heading = el.querySelector('h1, h2, h3') as HTMLElement | null;
    if (heading && !el.getAttribute('aria-labelledby')) {
      if (!heading.id) heading.id = 'dlg-' + Math.random().toString(36).slice(2, 9);
      el.setAttribute('aria-labelledby', heading.id);
    }

    this.previouslyFocused = document.activeElement as HTMLElement | null;

    // The rest of the page is not just visually behind the overlay, it
    // should not be reachable by a screen reader either.
    for (const sib of Array.from(document.body.children) as HTMLElement[]) {
      if (sib.contains(el) || sib === el) continue;
      if (sib.hasAttribute('aria-hidden')) continue;
      sib.setAttribute('aria-hidden', 'true');
      this.hidden.push(sib);
    }

    // Focus the dialog itself rather than its first control. A screen reader
    // then announces the dialog and its title, and the first Tab moves to the
    // first control. Focusing a control instead risks landing on "Close",
    // where pressing Enter would immediately dismiss the dialog the user has
    // only just opened.
    el.setAttribute('tabindex', '-1');
    // A tick, so the element is laid out and actually focusable.
    setTimeout(() => el.focus(), 0);
  }

  ngOnDestroy(): void {
    for (const sib of this.hidden) sib.removeAttribute('aria-hidden');
    this.hidden = [];
    // Put the keyboard user back where they were.
    this.previouslyFocused?.focus?.();
  }

  private focusable(): HTMLElement[] {
    const el = this.host.nativeElement as HTMLElement;
    return (Array.from(el.querySelectorAll(FOCUSABLE)) as HTMLElement[])
      // offsetParent is null for anything display:none, skip what cannot be seen.
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  @HostListener('keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const targets = this.focusable();
    if (!targets.length) { e.preventDefault(); return; }

    const first = targets[0];
    const last = targets[targets.length - 1];
    const active = document.activeElement as HTMLElement;

    // Wrap at both ends, and catch the case where focus has somehow
    // escaped the dialog already.
    if (e.shiftKey && (active === first || !this.host.nativeElement.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !this.host.nativeElement.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }
}
