import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { DialogService } from '../shared/dialog/dialog.service';

/** A page that can hold work the user has not saved yet. */
export interface HasUnsavedChanges {
  /** True when leaving now would throw away something the user typed. */
  hasUnsavedChanges(): boolean;
  /** Optional: save in place so the user can leave with their work kept.
   *  Resolves true only if it actually saved. */
  saveBeforeLeaving?(): Promise<boolean>;
}

/* Leaving the resume builder used to discard unsaved work in silence.
 *
 * The builder already listened for `beforeunload`, which covers closing the
 * tab or reloading. But not a click on "Openings" in the header. That is an
 * Angular route change: no unload event fires, the component is destroyed,
 * and twenty minutes of typing goes with it.
 *
 * This asked with the browser's confirm() at first, on the reasoning that it
 * was the one dialog guaranteed to be on screen. The expert review asked for
 * the site to handle it itself, and a route guard can wait on a promise, so
 * it now uses the site's own dialog, which can also offer what the browser's
 * could only describe: saving the draft on the way out. Staying is the
 * answer to anything but an explicit choice (Escape, the backdrop). */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = async (component) => {
  if (!component?.hasUnsavedChanges?.()) return true;
  const dialog = inject(DialogService);
  const canSave = typeof component.saveBeforeLeaving === 'function';
  const choice = await dialog.choose({
    title: 'Leave without saving?',
    message: 'You have changes on this resume that are not saved yet.',
    cancelValue: 'stay',
    choices: [
      { value: 'stay', label: 'Stay on this page', kind: 'ghost' },
      { value: 'leave', label: 'Leave and lose changes', kind: 'danger' },
      ...(canSave ? [{ value: 'save', label: 'Save draft and leave', kind: 'primary' as const }] : []),
    ],
  });
  if (choice === 'leave') return true;
  // A failed save (a required field missing, say) keeps them here, where the
  // page is already showing what went wrong.
  if (choice === 'save') return await component.saveBeforeLeaving!();
  return false;
};
