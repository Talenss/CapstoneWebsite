import { Injectable, signal } from '@angular/core';

/* The site's own confirm / prompt / notice, in place of the browser's.
 *
 * The expert review flagged the browser dialog ("linawph.online says…") as
 * something the site should handle itself, and it had a point beyond looks:
 * the browser's box names the domain rather than the site, cannot say which
 * button is the safe one, cannot offer a third choice such as "Save draft
 * and leave", and looks the same as the boxes phishing pages use.
 *
 * One dialog is shown at a time, by <app-dialog-host> in the app shell. Every
 * method returns a promise, so a caller reads exactly like the confirm() it
 * replaces: `if (!(await dialog.confirm({...}))) return;`. Dismissing the
 * dialog (Escape, the backdrop, Cancel) always resolves to the SAFE answer:
 * false, null, or the choice marked `cancel`.
 *
 * The one browser box that cannot be replaced is the one for closing or
 * reloading the tab (beforeunload). Browsers only allow their own there, on
 * purpose, so a page cannot hold anyone hostage; that one stays. */

export type ChoiceKind = 'primary' | 'danger' | 'ghost';

export interface DialogChoice<T extends string = string> {
  value: T;
  label: string;
  kind?: ChoiceKind;
}

export interface DialogRequest {
  title: string;
  message?: string;
  /** Choices in reading order, left to right. Put the safe one first: it is
   *  where the first Tab lands. */
  choices: DialogChoice[];
  /** The value Escape and the backdrop resolve to. */
  cancelValue: string;
  /** Present for a prompt: a text box with its current value and a check. */
  input?: {
    label: string;
    value: string;
    maxLength?: number;
    validate?: (v: string) => string;
  };
  resolve: (r: { choice: string; text?: string }) => void;
}

@Injectable({ providedIn: 'root' })
export class DialogService {
  readonly current = signal<DialogRequest | null>(null);

  /** The general form: pick one of several answers. */
  choose<T extends string>(o: {
    title: string; message?: string; choices: DialogChoice<T>[]; cancelValue: T;
  }): Promise<T> {
    return this.open({ ...o }).then((r) => r.choice as T);
  }

  /** Yes or no. `danger` paints the confirm button as destructive. */
  async confirm(o: {
    title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean;
  }): Promise<boolean> {
    const r = await this.open({
      title: o.title, message: o.message, cancelValue: 'no',
      // Cancel first, so it is where the first Tab lands.
      choices: [
        { value: 'no', label: o.cancelLabel ?? 'Cancel', kind: 'ghost' },
        { value: 'yes', label: o.confirmLabel ?? 'OK', kind: o.danger ? 'danger' : 'primary' },
      ],
    });
    return r.choice === 'yes';
  }

  /** Something the user should read, with one button. */
  async notice(o: { title: string; message?: string; okLabel?: string }): Promise<void> {
    await this.open({
      title: o.title, message: o.message, cancelValue: 'ok',
      choices: [{ value: 'ok', label: o.okLabel ?? 'OK', kind: 'primary' }],
    });
  }

  /** A line of text, or null if cancelled. `validate` returns an error to
   *  show under the box, or '' when the value is acceptable. */
  async prompt(o: {
    title: string; message?: string; label: string; value?: string; confirmLabel?: string;
    maxLength?: number; validate?: (v: string) => string;
  }): Promise<string | null> {
    const r = await this.open({
      title: o.title, message: o.message, cancelValue: 'no',
      input: { label: o.label, value: o.value ?? '', maxLength: o.maxLength, validate: o.validate },
      choices: [
        { value: 'no', label: 'Cancel', kind: 'ghost' },
        { value: 'yes', label: o.confirmLabel ?? 'Save', kind: 'primary' },
      ],
    });
    return r.choice === 'yes' ? (r.text ?? '') : null;
  }

  private open(o: Omit<DialogRequest, 'resolve'>): Promise<{ choice: string; text?: string }> {
    // A second request replaces the first, which is answered with its safe
    // value rather than left hanging.
    const prev = this.current();
    if (prev) prev.resolve({ choice: prev.cancelValue });
    return new Promise((resolve) => this.current.set({ ...o, resolve }));
  }

  /** Called by the host when an answer is given. */
  answer(choice: string, text?: string): void {
    const req = this.current();
    if (!req) return;
    this.current.set(null);
    req.resolve({ choice, text });
  }
}
