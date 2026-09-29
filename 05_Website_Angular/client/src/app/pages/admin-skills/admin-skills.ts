import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { DialogService } from '../../shared/dialog/dialog.service';
import { AdminSkill, ApiResult, SkillAdminView, TypedSkill } from '../../core/models';
import { applyDictionary } from '../../core/engine';

/** THE SKILL DICTIONARY, from the expert review: the admin panel should list
 *  the skills in the catalogue for editing, and let two terms be linked when
 *  they mean the same skill ([Git, GitHub], [Bookkeeping, Bookkeeper]).
 *
 *  Three things on one page, in the order they are usually needed:
 *    · link a term to a catalogue skill, the thing the review asked for
 *    · the terms people typed that the catalogue does not have, which is
 *      where a "GitHub" waiting to be linked is found
 *    · the catalogue itself: search, edit, remove, and add
 *  Every rule lives on the server (routes/skills.ts); this page only asks. */
@Component({
  selector: 'app-admin-skills',
  standalone: true,
  imports: [Header, Footer],
  templateUrl: './admin-skills.html',
  styleUrl: './admin-skills.css',
})
export class AdminSkills implements OnInit {
  private api = inject(ApiService);
  private dialog = inject(DialogService);

  view = signal<SkillAdminView | null>(null);
  loadError = signal('');
  toastMsg = signal<string | null>(null);
  busy = signal(false);

  // link form
  linkTerm = signal('');
  linkTarget = signal('');
  linkErr = signal('');

  // add form
  addName = signal('');
  addCategory = signal<'technical' | 'soft'>('technical');
  addIndustry = signal('');
  addErr = signal('');

  // catalogue filters
  q = signal('');
  industryF = signal('');

  // inline edit
  editId = signal<string | null>(null);
  editName = signal('');
  editCategory = signal<'technical' | 'soft'>('technical');
  editIndustry = signal('');
  editErr = signal('');

  readonly catalogue = computed(() => this.view()?.catalogue ?? []);
  readonly typed = computed(() => this.view()?.typed ?? []);
  readonly unlinkedTyped = computed(() => this.typed().filter((t) => !t.linkedTo).length);
  readonly industries = computed(() => this.view()?.industries ?? []);

  readonly shown = computed<AdminSkill[]>(() => {
    const q = this.q().trim().toLowerCase();
    const ind = this.industryF();
    return this.catalogue().filter((s) => {
      if (ind && s.industry !== ind) return false;
      if (!q) return true;
      return [s.name, s.industry, ...s.links.map((l) => l.name), ...s.builtIn].join(' ').toLowerCase().includes(q);
    });
  });

  async ngOnInit(): Promise<void> {
    const r = await this.api.skills.admin();
    if (!r.ok) { this.loadError.set(r.error); return; }
    this.view.set(r);
  }

  val(e: Event): string { return (e.target as HTMLInputElement).value; }

  /** Takes the fresh view from any edit and brings this browser's own
   *  engine up to date with it, so the rest of this session scores with the
   *  dictionary just saved. */
  private async apply(r: ApiResult<SkillAdminView>, onError: (m: string) => void, done: string): Promise<boolean> {
    if (!r.ok) { onError(r.error); return false; }
    this.view.set(r);
    const d = await this.api.skills.dictionary();
    if (d.ok) applyDictionary(d);
    this.showToast(done);
    return true;
  }

  private targetId(name: string): string | null {
    const n = name.trim().toLowerCase();
    return this.catalogue().find((s) => s.name.toLowerCase() === n)?.id ?? null;
  }

  async link(e?: Event): Promise<void> {
    e?.preventDefault();
    this.linkErr.set('');
    const term = this.linkTerm().trim();
    const target = this.linkTarget().trim();
    if (!term) { this.linkErr.set('Enter the term that should count as a catalogue skill.'); return; }
    const id = this.targetId(target);
    if (!id) { this.linkErr.set('Pick the skill it counts as from the catalogue list.'); return; }
    const targetName = this.catalogue().find((s) => s.id === id)!.name;
    const ok = await this.dialog.confirm({
      title: `Count "${term}" as ${targetName}?`,
      message: `From now on, a resume or an opening that says either one matches the other, for every company. `
        + `Scores shown from now on follow the link. A score already recorded on an application is kept as it was, `
        + `and the recruiter's list marks it if it would now be different.`,
      confirmLabel: 'Link them',
    });
    if (!ok) return;
    this.busy.set(true);
    const r = await this.api.skills.link(term, id);
    this.busy.set(false);
    if (await this.apply(r, (m) => this.linkErr.set(m), `"${term}" now counts as ${targetName}.`)) {
      this.linkTerm.set(''); this.linkTarget.set('');
    }
  }

  async unlink(s: AdminSkill, l: { norm: string; name: string }): Promise<void> {
    const ok = await this.dialog.confirm({
      title: `Stop counting "${l.name}" as ${s.name}?`,
      message: 'They are matched as two different skills again from now on.',
      confirmLabel: 'Unlink', danger: true,
    });
    if (!ok) return;
    const r = await this.api.skills.unlink(l.norm);
    await this.apply(r, (m) => this.showToast(m), `"${l.name}" is no longer linked to ${s.name}.`);
  }

  /** From the typed list: fill the link form with this term. */
  countAs(t: TypedSkill): void {
    this.linkTerm.set(t.name);
    this.linkErr.set('');
    document.getElementById('linkCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => (document.getElementById('linkTarget') as HTMLInputElement | null)?.focus({ preventScroll: true }), 350);
  }

  /** From the typed list: fill the add form with this term. */
  addFromTyped(t: TypedSkill): void {
    this.addName.set(t.name);
    this.addErr.set('');
    document.getElementById('addCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => (document.getElementById('addIndustry') as HTMLInputElement | null)?.focus({ preventScroll: true }), 350);
  }

  async add(e: Event): Promise<void> {
    e.preventDefault();
    this.addErr.set('');
    const name = this.addName().trim();
    this.busy.set(true);
    const r = await this.api.skills.add({ name, category: this.addCategory(), industry: this.addIndustry() });
    this.busy.set(false);
    if (await this.apply(r, (m) => this.addErr.set(m), `${name} is in the catalogue.`)) {
      this.addName.set(''); this.addIndustry.set(''); this.addCategory.set('technical');
    }
  }

  startEdit(s: AdminSkill): void {
    this.editId.set(s.id); this.editName.set(s.name);
    this.editCategory.set(s.category); this.editIndustry.set(s.industry); this.editErr.set('');
  }
  cancelEdit(): void { this.editId.set(null); }

  async saveEdit(s: AdminSkill): Promise<void> {
    this.editErr.set('');
    const r = await this.api.skills.update({
      id: s.id, name: this.editName(), category: this.editCategory(), industry: this.editIndustry(),
    });
    if (await this.apply(r, (m) => this.editErr.set(m), `${this.editName().trim() || s.name} saved.`)) this.editId.set(null);
  }

  async remove(s: AdminSkill): Promise<void> {
    const used = s.resumes + s.postings;
    const ok = await this.dialog.confirm({
      title: `Take ${s.name} out of the catalogue?`,
      message: 'It stops being offered in the skill pickers. '
        + (used ? `The ${s.resumes} resume(s) and ${s.postings} opening(s) that already use it keep it, and still match on it. ` : '')
        + 'You can add it back at any time.',
      confirmLabel: 'Take it out', danger: true,
    });
    if (!ok) return;
    const r = await this.api.skills.remove(s.id);
    await this.apply(r, (m) => this.showToast(m), `${s.name} is out of the catalogue.`);
  }

  usedLabel(s: { resumes: number; postings: number }): string {
    if (!s.resumes && !s.postings) return 'Not used yet';
    const parts = [];
    if (s.resumes) parts.push(`${s.resumes} resume${s.resumes === 1 ? '' : 's'}`);
    if (s.postings) parts.push(`${s.postings} opening${s.postings === 1 ? '' : 's'}`);
    return parts.join(', ');
  }

  linkTitle(l: { by: string | null; at: number }): string {
    const when = l.at ? new Date(l.at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    return `Linked${l.by ? ' by ' + l.by : ''}${when ? ' on ' + when : ''}. Click to unlink.`;
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 4200);
  }
}
