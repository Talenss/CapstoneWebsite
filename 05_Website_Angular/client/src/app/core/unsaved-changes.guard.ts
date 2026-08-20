import { CanDeactivateFn } from '@angular/router';

/** A page that can hold work the user has not saved yet. */
export interface HasUnsavedChanges {
  /** True when leaving now would throw away something the user typed. */
  hasUnsavedChanges(): boolean;
}

/* Leaving the resume builder used to discard unsaved work in silence.
 *
 * The builder already listened for `beforeunload`, which covers closing the
 * tab or reloading. But not a click on "Openings" in the header. That is an
 * Angular route change: no unload event fires, the component is destroyed,
 * and twenty minutes of typing goes with it. Nothing warned, and nothing in
 * the interface hinted that it would happen.
 *
 * A confirm() is deliberate rather than a styled modal: a route change is
 * synchronous, so the answer has to come back before navigation proceeds, and
 * the browser's own dialog is the one thing guaranteed to be visible at that
 * moment. Saving first is always the better path, and the message says so. */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (!component?.hasUnsavedChanges?.()) return true;
  return confirm('You have changes that are not saved yet. Leave this page and lose them?\n\nCancel, then use "Save draft" to keep them.');
};
