import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { DialogService } from './dialog.service';
import { FocusTrapDirective } from '../focus-trap.directive';

/** Draws whatever DialogService is asking, using the site's own modal
 *  styles. Mounted once, in the app shell, so every page gets it without
 *  having to include anything. */
@Component({
  selector: 'app-dialog-host',
  standalone: true,
  imports: [FocusTrapDirective],
  template: `
    @if (dialog.current(); as d) {
      <div class="modal-back show dlg-back" (click)="onBackdrop($event)">
        <div class="modal dlg" appFocusTrap>
          <div class="modal-head"><h3>{{ d.title }}</h3></div>
          <div class="modal-body">
            @if (d.message) { <p class="dlg-msg">{{ d.message }}</p> }
            @if (d.input; as inp) {
              <div class="field" [class.invalid]="!!error()" style="margin:6px 0 0">
                <label for="dlgInput">{{ inp.label }}</label>
                <input id="dlgInput" type="text" [value]="text()" [attr.maxlength]="inp.maxLength ?? null"
                       (input)="onText($event)" (keydown.enter)="submitInput()">
                <p class="err">{{ error() }}</p>
              </div>
            }
          </div>
          <div class="modal-foot">
            @for (c of d.choices; track c.value) {
              <button type="button" class="btn sm"
                      [class.primary]="c.kind === 'primary'"
                      [class.danger-solid]="c.kind === 'danger'" [class.ghost]="c.kind === 'ghost' || !c.kind"
                      (click)="pick(c.value)">{{ c.label }}</button>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .dlg-back { align-items: center; z-index: 1000; }
    .dlg { max-width: 460px; }
    .dlg .modal-head h3 { font-size: 21px; }
    .dlg-msg { font-size: 14px; color: var(--text); line-height: 1.6; white-space: pre-line; margin: 0; }
    /* Destructive: solid wine, so it is never mistaken for the brand-red
       primary action and never looks like the safe choice. */
    .btn.danger-solid { background: var(--wine); color: #fff; border-color: var(--wine); }
    .btn.danger-solid:hover { background: var(--wine); filter: brightness(.92); }
  `],
})
export class DialogHost {
  dialog = inject(DialogService);
  text = signal('');
  touched = signal(false);

  readonly error = computed(() => {
    const inp = this.dialog.current()?.input;
    if (!inp?.validate || !this.touched()) return '';
    return inp.validate(this.text());
  });

  constructor() {
    // Each new prompt starts from its own value, not the last one typed.
    effect(() => {
      const d = this.dialog.current();
      this.text.set(d?.input?.value ?? '');
      this.touched.set(false);
      // A prompt is about the box, so the box gets the cursor, text selected.
      if (d?.input) setTimeout(() => {
        const el = document.getElementById('dlgInput') as HTMLInputElement | null;
        el?.focus(); el?.select();
      }, 20);
    });
  }

  onText(e: Event): void { this.text.set((e.target as HTMLInputElement).value); this.touched.set(true); }

  submitInput(): void { this.pick('yes'); }

  pick(value: string): void {
    const d = this.dialog.current();
    if (!d) return;
    if (d.input && value !== d.cancelValue) {
      this.touched.set(true);
      if (d.input.validate && d.input.validate(this.text())) return;
    }
    this.dialog.answer(value, d.input ? this.text() : undefined);
  }

  onBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.pick(this.dialog.current()!.cancelValue);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    const d = this.dialog.current();
    if (d) this.pick(d.cancelValue);
  }
}
