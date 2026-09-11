import { Component, computed, input, output, signal } from '@angular/core';
import { FocusTrapDirective } from '../focus-trap.directive';
import { ApplicationAnswer, Posting } from '../../core/models';

/* THE RECRUITER'S OWN QUESTIONS, ASKED AT THE MOMENT OF APPLYING.
 *
 * Shared by both places an application can be sent from — Browse openings and
 * the seeker dashboard — because a question that is mandatory on one screen
 * and skippable on the other is not mandatory. One component, one rule, and
 * the server checks the same rule again before it accepts the row.
 *
 * Nothing here is scored. These answers never reach the engine: they are free
 * text a recruiter reads beside the resume, which is exactly the division the
 * whole system runs on — the software measures what it can state a rule for
 * and hands the rest to a person.
 */
@Component({
  selector: 'app-apply-questions',
  standalone: true,
  imports: [FocusTrapDirective],
  templateUrl: './apply-questions.html',
  styleUrl: './apply-questions.css',
})
export class ApplyQuestions {
  /** The opening being applied to. Its `questions` are what we ask. */
  posting = input.required<Posting>();
  /** True while the application is in flight, so the button can say so. */
  sending = input(false);

  answered = output<ApplicationAnswer[]>();
  cancelled = output<void>();

  readonly MAX_LEN = 2000;

  /** Keyed by question id so reordering the list on the opening cannot move
   *  an answer onto a different question. */
  private text = signal<Record<string, string>>({});

  questions = computed(() => this.posting().questions ?? []);

  valueOf(id: string): string { return this.text()[id] ?? ''; }

  set(id: string, e: Event): void {
    const v = (e.target as HTMLTextAreaElement).value.slice(0, this.MAX_LEN);
    this.text.update((m) => ({ ...m, [id]: v }));
  }

  /** Shown per question only once the applicant has tried to submit — marking
   *  a field red before it has been reached is a scolding, not a prompt. */
  tried = signal(false);
  missing = (id: string): boolean => this.tried() && !this.valueOf(id).trim();

  unanswered = computed(() =>
    this.questions().filter((q) => !(this.text()[q.id ?? ''] ?? '').trim()).length);

  submit(): void {
    this.tried.set(true);
    if (this.unanswered() > 0) {
      // Put the keyboard on the first one that is blank rather than only
      // colouring it, so this works for someone who cannot see the colour.
      const first = this.questions().find((q) => !(this.text()[q.id ?? ''] ?? '').trim());
      if (first?.id) document.getElementById('q-' + first.id)?.focus();
      return;
    }
    this.answered.emit(this.questions().map((q) => ({
      questionId: String(q.id),
      prompt: q.prompt,
      answer: this.valueOf(String(q.id)).trim(),
    })));
  }
}
