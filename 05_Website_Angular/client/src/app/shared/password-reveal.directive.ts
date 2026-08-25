/* ResumeMatch PH, shared/password-reveal.directive.ts

   Lets someone check what they have typed into a password box.

   Typing a password blind is the ordinary cause of a failed sign-in that
   the person cannot explain: the field says nothing about what went in,
   and "incorrect password" cannot distinguish a wrong password from a
   right one typed with caps lock on, a phone keyboard's autocapitalised
   first letter, or a stray space from a paste. That falls hardest on the
   applicants this study is for, many of whom are on a phone.

   Applied with [appPasswordReveal] on the input. It:
     · adds a Show / Hide button inside the right edge of the field
     · toggles the input between password and text
     · keeps the caret where it was, so revealing mid-typing does not
       send the cursor to the end
     · returns to hidden when the field loses focus, so a revealed
       password is not left on screen for whoever walks past next
     · is a real <button type="button">, so it never submits the form
       and a keyboard reaches it in the normal tab order

   The button is created here rather than written into each template
   because there are eight password fields across two pages, and eight
   copies of the same markup and state is how they drift apart.

   No inline handlers: the build's CSP guard rejects them, and the
   deployed Content-Security-Policy would block them anyway. */
import {
  Directive, ElementRef, OnInit, OnDestroy, Renderer2, inject,
} from '@angular/core';

@Directive({
  selector: 'input[appPasswordReveal]',
  standalone: true,
})
export class PasswordRevealDirective implements OnInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLInputElement>);
  private readonly r = inject(Renderer2);

  private button?: HTMLButtonElement;
  private shown = false;
  private cleanup: (() => void)[] = [];

  ngOnInit(): void {
    const input: HTMLInputElement = this.host.nativeElement;
    const parent: HTMLElement | null = input.parentElement;
    if (!parent) return;

    /* The wrapper becomes the positioning context. It is .field in every
       current use, which has no position of its own, so this is additive. */
    this.r.addClass(parent, 'pw-wrap');
    this.r.addClass(input, 'pw-input');

    const btn: HTMLButtonElement = this.r.createElement('button');
    this.r.setAttribute(btn, 'type', 'button');       // never submits the form
    this.r.setAttribute(btn, 'tabindex', '0');
    this.r.addClass(btn, 'pw-toggle');
    this.setLabel(btn);
    this.r.appendChild(btn, this.r.createText('Show'));
    this.r.insertBefore(parent, btn, input.nextSibling);
    this.button = btn;

    this.cleanup.push(this.r.listen(btn, 'click', () => this.toggle()));
    /* Hide again on blur. Leaving a password legible after someone tabs
       away is worse than the problem this solves. A click on the button
       itself is not a blur away from the field, so relatedTarget is
       checked before hiding. */
    this.cleanup.push(this.r.listen(input, 'blur', (e: FocusEvent) => {
      if (e.relatedTarget !== btn && this.shown) this.toggle();
    }));
  }

  ngOnDestroy(): void {
    for (const off of this.cleanup) off();
    this.button?.remove();
  }

  private setLabel(btn: HTMLButtonElement): void {
    this.r.setAttribute(btn, 'aria-label', this.shown ? 'Hide password' : 'Show password');
    this.r.setAttribute(btn, 'aria-pressed', String(this.shown));
  }

  private toggle(): void {
    const input: HTMLInputElement = this.host.nativeElement;
    const btn = this.button;
    if (!btn) return;

    /* Changing type resets the caret in several browsers. Restoring the
       selection keeps someone's place when they reveal mid-word. */
    const start = input.selectionStart;
    const end = input.selectionEnd;

    this.shown = !this.shown;
    this.r.setAttribute(input, 'type', this.shown ? 'text' : 'password');
    btn.textContent = this.shown ? 'Hide' : 'Show';
    this.setLabel(btn);

    if (start !== null && end !== null) {
      try { input.setSelectionRange(start, end); } catch { /* type change raced */ }
      input.focus();
    }
  }
}
