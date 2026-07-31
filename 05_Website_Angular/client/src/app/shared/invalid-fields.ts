/* ResumeMatch PH — shared/invalid-fields.ts

   Every form in the app rejects a field the same way: .invalid goes onto
   the surrounding .field, which turns the control's border red and reveals
   the <span class="err"> already sitting inside it.

   That was the whole story — which meant that for anyone not looking at the
   screen there was no story at all:

     · no control ever carried aria-invalid, so a screen reader had no way
       to know the field had been rejected at all;
     · the error text was never tied to its control, so landing on the field
       announced the label and stopped there — the sentence explaining what
       was wrong sat in the DOM, unread;
     · focus never moved. Two of the forms scrolled the window to the top,
       which helps only someone who can see where it landed; the rest did
       nothing. The summary then said to fix "the highlighted fields", and
       highlighting is a purely visual property.

   So the failure mode was: press Publish, hear "Fill in the highlighted
   fields before publishing", and have no way to find out which ones.

   Call it right after setting the invalid flags. It returns true when
   nothing was wrong, so a handler reads as:

       if (!reportInvalidFields([{ id: 'title', invalid: !titleOk }, …])) return;

   The state is passed in rather than read back off the DOM on purpose. The
   flags live in signals that were written a line earlier, and Angular has
   not rendered them yet — inspecting .invalid here would test the PREVIOUS
   submission's classes. Taking the truth from the caller sidesteps render
   timing entirely, and the array's order is the reading order the author
   declares rather than one inferred from the document. */

/** A stable-enough id for an error span that has none of its own. */
let seq = 0;
function ensureId(el: HTMLElement): string {
  if (!el.id) el.id = 'err-' + (++seq) + '-' + Math.random().toString(36).slice(2, 7);
  return el.id;
}

export interface FieldState {
  /** The id of the control itself — the input, select or textarea. */
  id: string;
  invalid: boolean;
}

/**
 * Reconciles each control's ARIA with the verdict just reached, then puts
 * the keyboard on the first field that failed.
 *
 * @returns true when every field passed — nothing was focused.
 */
export function reportInvalidFields(fields: FieldState[]): boolean {
  let first: HTMLElement | null = null;

  for (const { id, invalid } of fields) {
    const control = document.getElementById(id);
    if (!control) continue;

    // Tie the control to its own error text. Done for valid fields too, and
    // left in place afterwards: .field .err is display:none until the field
    // goes invalid, and a description that is not rendered is not announced,
    // so the wiring costs nothing while the field is fine.
    const err = control.closest('.field')?.querySelector('.err') as HTMLElement | null;
    if (err) {
      const errId = ensureId(err);
      const described = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      if (!described.includes(errId)) {
        control.setAttribute('aria-describedby', [...described, errId].join(' '));
      }
    }

    if (invalid) {
      control.setAttribute('aria-invalid', 'true');
      if (!first) first = control;
    } else {
      // Removed rather than set to "false": a stale aria-invalid on a field
      // the user has since corrected is worse than none at all.
      control.removeAttribute('aria-invalid');
    }
  }

  if (!first) return true;

  // Focus first without scrolling, then centre it deliberately. Letting
  // focus() do the scrolling parks the field hard against the viewport's
  // top edge, underneath the sticky header.
  first.focus({ preventScroll: true });
  first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}
