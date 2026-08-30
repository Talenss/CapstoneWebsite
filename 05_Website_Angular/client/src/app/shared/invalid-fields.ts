/* Rejecting a field used to be purely visual: .invalid turned a border red
   and revealed the error span. For anyone not looking at the screen there was
   nothing at all — no aria-invalid, no link between the error text and its
   control, and no focus move. The failure mode was pressing Publish, hearing
   "fix the highlighted fields", and having no way to find out which.

   Call it right after setting the invalid flags; it returns true when nothing
   was wrong:

       if (!reportInvalidFields([{ id: 'title', invalid: !titleOk }, …])) return;

   State is passed in rather than read off the DOM because the flags live in
   signals written a line earlier and Angular has not rendered them yet —
   inspecting .invalid here would test the PREVIOUS submission. */

/** A stable-enough id for an error span that has none of its own. */
let seq = 0;
function ensureId(el: HTMLElement): string {
  if (!el.id) el.id = 'err-' + (++seq) + '-' + Math.random().toString(36).slice(2, 7);
  return el.id;
}

export interface FieldState {
  /** The id of the control itself, the input, select or textarea. */
  id: string;
  invalid: boolean;
}

/**
 * Reconciles each control's ARIA with the verdict just reached, then puts
 * the keyboard on the first field that failed.
 *
 * Pass `{ focus: false }` to reconcile only. That is what a form calls while
 * the user is still typing: the mark on a field they have just corrected
 * must come off, including its aria-invalid, or a screen reader goes on
 * reporting an error the sighted user can see has gone, but pulling focus
 * mid-keystroke would be a worse bug than the stale mark.
 *
 * @returns true when every field passed, nothing was focused.
 */
export function reportInvalidFields(fields: FieldState[], opts: { focus?: boolean } = {}): boolean {
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
  if (opts.focus === false) return false;

  // Focus first without scrolling, then centre it deliberately. Letting
  // focus() do the scrolling parks the field hard against the viewport's
  // top edge, underneath the sticky header.
  first.focus({ preventScroll: true });
  first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}
