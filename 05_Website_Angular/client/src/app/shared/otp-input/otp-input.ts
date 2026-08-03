import { Component, ElementRef, computed, forwardRef, input, signal, viewChildren } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

/* ResumeMatch PH — shared/otp-input
   ------------------------------------------------------------------
   One box per digit for the six-digit codes the app emails: at sign-up,
   at password reset, and when changing an account's email address.

   It was a single text box before, which worked. What a box per digit buys,
   and the reason the QA review raised it, is that the code arrives in an
   EMAIL on this system — not an SMS — so the realistic action is a paste,
   often of something with spaces or a stray character attached. A single
   maxlength=6 field silently truncates "483 920" to "483 92". Here every
   paste is caught and stripped to digits before it lands, so the same
   clipboard content fills the boxes correctly.

   Written as a ControlValueAccessor so the three call sites keep their
   existing [(ngModel)] and (ngModelChange) bindings unchanged — the forms'
   validation, their error spans and the shared reportInvalidFields() focus
   handling all keep working without knowing the control was replaced.

   The accessibility of a segmented input is the part that is usually done
   badly, and it is worth being explicit about what is done here, because
   six unlabelled boxes are decidedly WORSE than one labelled field:

     · the first box carries the caller's id, so the existing
       <label for="…"> still names it, and reportInvalidFields() can still
       find it to set aria-invalid, wire aria-describedby to the .err
       message, and move the keyboard to it on a failed submit;
     · the boxes sit in a role="group" carrying the field's name, so a
       screen reader announces "6-digit code" once on entry rather than
       leaving six anonymous inputs;
     · each box is labelled "Digit n of 6", so its position is spoken;
     · only the first box takes autocomplete="one-time-code" — the browser
       fills the whole code into it, and onInput spreads it across the rest.

   Everything is a real <input>, so browser autofill, password managers and
   assistive technology see ordinary form controls.  */
@Component({
  selector: 'app-otp-input',
  standalone: true,
  templateUrl: './otp-input.html',
  styleUrl: './otp-input.css',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => OtpInput), multi: true }],
})
export class OtpInput implements ControlValueAccessor {
  /** How many digits. Six everywhere today; an input so it is not a lie. */
  length = input(6);
  /** Goes on the FIRST box: what <label for> points at, and what
   *  reportInvalidFields() looks up to focus and mark the field. */
  inputId = input('');
  /** Names the whole group for a screen reader. */
  groupLabel = input('6-digit code');

  private boxes = viewChildren<ElementRef<HTMLInputElement>>('box');

  digits = signal<string[]>([]);
  isDisabled = signal(false);
  slots = computed(() => Array.from({ length: this.length() }, (_, i) => i));

  private onChange: (v: string) => void = () => {};
  private onTouched: () => void = () => {};

  // ---------- ControlValueAccessor ----------
  writeValue(v: string | null): void {
    this.apply(String(v ?? '').replace(/\D/g, '').slice(0, this.length()).split(''), false);
  }
  registerOnChange(fn: (v: string) => void): void { this.onChange = fn; }
  registerOnTouched(fn: () => void): void { this.onTouched = fn; }
  setDisabledState(d: boolean): void { this.isDisabled.set(d); }

  /** Called on blur — the form decides what to do with it. */
  markTouched(): void { this.onTouched(); }

  // ---------- editing ----------
  onInput(i: number, e: Event): void {
    const typed = (e.target as HTMLInputElement).value.replace(/\D/g, '');
    if (!typed) { this.put(i, ''); return; }
    /* More than one digit in a single box means the browser put it there:
       a paste it decided to allow, or a one-time-code autofill dropping the
       whole thing into the first box. Either way it is the code, so spread
       it rather than keeping the first character and dropping the rest. */
    if (typed.length > 1) { this.spread(i, typed); return; }
    this.put(i, typed);
    this.focusBox(i + 1);
  }

  onKeydown(i: number, e: KeyboardEvent): void {
    if (e.key === 'Backspace') {
      /* Handled rather than left to the browser so that backspacing out of
         an already-empty box steps back and clears the one before it. Without
         that, correcting a typo two boxes ago means clicking into it. */
      e.preventDefault();
      if (this.digits()[i]) { this.put(i, ''); return; }
      if (i > 0) { this.put(i - 1, ''); this.focusBox(i - 1); }
      return;
    }
    if (e.key === 'Delete') { e.preventDefault(); this.put(i, ''); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.focusBox(i - 1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); this.focusBox(i + 1); return; }
    if (e.key === 'Home') { e.preventDefault(); this.focusBox(0); return; }
    if (e.key === 'End') { e.preventDefault(); this.focusBox(this.length() - 1); }
  }

  onPaste(i: number, e: ClipboardEvent): void {
    const digits = (e.clipboardData?.getData('text') ?? '').replace(/\D/g, '');
    if (!digits) return;
    /* Stripping non-digits here is the whole point of the exercise: a code
       copied out of an email routinely arrives as "483 920", or with a full
       stop stuck to the end of the sentence it sat in. */
    e.preventDefault();
    this.spread(i, digits);
  }

  /** Selecting the contents on focus is what makes typing over a filled box
   *  replace the digit instead of appending a second one to it.
   *
   *  setSelectionRange, NOT select(). select() focuses the element as a side
   *  effect, and focusing schedules another select — so once two boxes each
   *  had one pending, they took focus off each other and rescheduled, over
   *  and over. The first version of this used `setTimeout(() => el.select())`
   *  and produced an unbounded focus loop: hundreds of focus events a second,
   *  for as long as the page was open. setSelectionRange changes only the
   *  selection, so there is nothing to feed back. */
  onFocus(i: number): void {
    const el = this.boxes()[i]?.nativeElement;
    if (el) el.setSelectionRange(0, el.value.length);
  }

  // ---------- internals ----------
  private put(i: number, ch: string): void {
    const next = [...this.digits()];
    next[i] = ch;
    this.apply(next, true);
  }

  private spread(from: number, str: string): void {
    const len = this.length();
    /* A full-length paste is the whole code and belongs at the start,
       whichever box happened to have the caret. A shorter one is a fragment
       the user is placing deliberately, so it goes where they put it. */
    const start = str.length >= len ? 0 : from;
    const next = [...this.digits()];
    for (let k = 0; k < str.length && start + k < len; k++) next[start + k] = str[k];
    this.apply(next, true);
    this.focusBox(Math.min(start + str.length, len - 1));
  }

  private apply(arr: string[], emit: boolean): void {
    const next = Array.from({ length: this.length() }, (_, i) => arr[i] ?? '');
    this.digits.set(next);
    this.paint();
    if (emit) this.onChange(next.join(''));
  }

  /** Write the model back over the DOM.
   *
   *  Not redundant with the [value] binding. After a paste is spread, a box
   *  whose digit did not change keeps whatever the browser typed into it —
   *  so the box the paste landed in shows all six characters while every
   *  other box shows one. Angular has no reason to touch it, because as far
   *  as the binding is concerned nothing about that box changed. */
  private paint(): void {
    const d = this.digits();
    this.boxes().forEach((ref, i) => { ref.nativeElement.value = d[i] ?? ''; });
  }

  private focusBox(i: number): void {
    const el = this.boxes()[Math.max(0, Math.min(this.length() - 1, i))]?.nativeElement;
    if (!el) return;
    el.focus();
    // focus() fires onFocus, which selects the contents. Nothing more to do,
    // and calling select() here would be the side-effecting call that caused
    // the focus loop described above.
  }
}
