import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Header } from '../../layout/header/header';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { TourService } from '../../shared/tour/tour.service';
import { EDU_LABELS } from '../../core/engine';
import { Education, EduLevel, Experience, Resume, Template } from '../../core/models';

const STEPS = ['Details', 'Education', 'Experience', 'Skills', 'Certifications', 'Finish'];

function blankResume(id: string | null = null): Resume {
  return {
    id,
    title: '',
    template: 'chronological',
    personal: { fullName: '', email: '', phone: '', address: '', summary: '' },
    education: [],
    experience: [],
    skills: [],
    certifications: [],
    ownFile: null,
  };
}

const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

/** Port of 04_Website/app/resume-builder.html — the 6-step guided
 *  resume wizard with a live document preview. The original leaned on
 *  a generic repeat() DOM-builder and manual paint()/innerHTML calls
 *  on every keystroke; here the whole `resume` signal drives real
 *  Angular templates (form sections + the preview pane) directly, so
 *  there's nothing to manually repaint. */
@Component({
  selector: 'app-resume-builder',
  standalone: true,
  imports: [Header, NgTemplateOutlet],
  templateUrl: './resume-builder.html',
  styleUrl: './resume-builder.css',
})
export class ResumeBuilder implements OnInit {
  private api = inject(ApiService);
  private session = inject(SessionService);
  private tour = inject(TourService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  readonly STEPS = STEPS;
  readonly eduLevelOptions: { value: EduLevel; label: string }[] = [
    { value: 'highschool', label: EDU_LABELS.highschool },
    { value: 'vocational', label: EDU_LABELS.vocational },
    { value: 'associate', label: EDU_LABELS.associate },
    { value: 'bachelor', label: EDU_LABELS.bachelor },
    { value: 'master', label: EDU_LABELS.master },
  ];

  ready = signal(false);
  resume = signal<Resume>(blankResume());
  step = signal(0);
  dirty = signal(false);
  saving = signal(false);
  savedFlag = signal(false);
  formError = signal<string | null>(null);
  toastMsg = signal<string | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** Demand tally + sorted skill list, built once from every currently
   *  open posting — powers the datalist and the suggestion-chip pool. */
  demanded = signal<Record<string, number>>({});
  poolAll = signal<string[]>([]);

  pageTitle = computed(() => (this.resume().id ? 'Edit resume' : 'Build your resume'));
  templateLabel = computed(() => {
    const t = this.resume().template;
    return t.charAt(0).toUpperCase() + t.slice(1);
  });
  contactLine = computed(() => {
    const p = this.resume().personal;
    return [p.email, p.phone, p.address].filter(Boolean).join('  ·  ');
  });
  visibleEducation = computed(() => this.resume().education.filter((e) => e.school || e.degree));
  visibleExperience = computed(() => this.resume().experience.filter((e) => e.position || e.company));
  visibleCertifications = computed(() => this.resume().certifications.filter((c) => c.name));
  poolSuggestions = computed(() => {
    const have = new Set(this.resume().skills.map((s) => s.toLowerCase()));
    return this.poolAll().filter((s) => !have.has(s.toLowerCase()));
  });
  checklist = computed(() => {
    const r = this.resume();
    return [
      { label: 'Your name and a way to contact you', done: !!(r.personal.fullName && (r.personal.email || r.personal.phone)), optional: false },
      { label: 'A short summary', done: (r.personal.summary || '').trim().length >= 20, optional: false },
      { label: 'At least one education entry', done: r.education.length > 0, optional: false },
      { label: 'At least three skills', done: r.skills.length >= 3, optional: false },
      { label: 'Experience (optional — many openings ask for none)', done: r.experience.length > 0, optional: true },
      { label: 'Your own resume file (optional)', done: !!r.ownFile, optional: true },
    ];
  });
  fileUrl = computed(() => {
    const r = this.resume();
    if (!r.ownFile) return null;
    return r.id ? this.api.resumes.fileUrl(r.id) : r.ownFile.dataUrl || null;
  });

  async ngOnInit(): Promise<void> {
    const user = this.session.user()!;
    const id = this.route.snapshot.queryParamMap.get('id');
    const welcome = this.route.snapshot.queryParamMap.get('welcome');

    if (id) {
      const res = await this.api.resumes.get(id);
      if (!res.ok) {
        this.router.navigateByUrl('/my-resumes', { replaceUrl: true });
        return;
      }
      this.resume.set(res.resume);
    } else {
      this.resume.update((r) => ({ ...r, title: 'My resume', personal: { ...r.personal, fullName: user.name, email: user.email } }));
    }
    if (welcome) this.showToast('Account created. Let’s build your resume.');

    const pRes = await this.api.postings.open();
    const demandedMap: Record<string, number> = {};
    if (pRes.ok) {
      for (const p of pRes.postings) for (const s of p.skills) demandedMap[s] = (demandedMap[s] || 0) + 1;
    }
    this.demanded.set(demandedMap);
    this.poolAll.set(Object.keys(demandedMap).sort((a, b) => demandedMap[b] - demandedMap[a] || a.localeCompare(b)));

    this.ready.set(true);

    this.tour.init(
      'builder',
      [
        { sel: '#rail', title: 'Six steps, in order', text: 'Move with Next, or jump straight to any step. Nothing is scored until you save, and you can come back and edit forever.' },
        { sel: '#paper', title: 'It builds as you type', text: 'This is the actual document a recruiter reads. Change a field on the left and watch it appear here.' },
        { sel: '#s0 .field', title: 'Start with the basics', text: 'Name, contact, and two or three plain sentences about yourself. Skip adjectives like "hardworking" — say what you did instead.' },
        { sel: '[data-tour]', title: 'This tour is always here', text: 'Stuck on a step? Reopen this from any page. There’s also a Learning hub with full guides on ATS formatting.' },
      ],
      { user: user.id },
    );
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void {
    if (this.dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  /** Reads the current value out of an (input)/(change) DOM event —
   *  shared by every plain text/select/textarea binding in the template. */
  inputValue(e: Event): string {
    return (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  private markDirty(): void {
    this.dirty.set(true);
    this.savedFlag.set(false);
  }

  goTo(i: number): void {
    this.step.set(Math.max(0, Math.min(STEPS.length - 1, i)));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- details ----------
  setTitle(v: string): void {
    this.resume.update((r) => ({ ...r, title: v }));
    this.markDirty();
  }
  setPersonal(field: string, v: string): void {
    this.resume.update((r) => ({ ...r, personal: { ...r.personal, [field]: v } }));
    this.markDirty();
  }

  // ---------- education ----------
  addEducation(): void {
    this.resume.update((r) => ({ ...r, education: [...r.education, { school: '', degree: '', level: 'bachelor', year: '' } as Education] }));
    this.markDirty();
  }
  updateEducation(i: number, field: string, v: string): void {
    this.resume.update((r) => ({ ...r, education: r.education.map((e, idx) => (idx === i ? { ...e, [field]: v } : e)) }));
    this.markDirty();
  }
  removeEducation(i: number): void {
    this.resume.update((r) => ({ ...r, education: r.education.filter((_, idx) => idx !== i) }));
    this.markDirty();
  }

  // ---------- experience ----------
  addExperience(): void {
    this.resume.update((r) => ({ ...r, experience: [...r.experience, { position: '', company: '', months: 0, description: '' }] }));
    this.markDirty();
  }
  updateExperience(i: number, field: 'position' | 'company' | 'months' | 'description', v: string): void {
    this.resume.update((r) => ({
      ...r,
      experience: r.experience.map((exp, idx): Experience => {
        if (idx !== i) return exp;
        switch (field) {
          case 'months': return { ...exp, months: Number(v) || 0 };
          case 'position': return { ...exp, position: v };
          case 'company': return { ...exp, company: v };
          case 'description': return { ...exp, description: v };
        }
      }),
    }));
    this.markDirty();
  }
  removeExperience(i: number): void {
    this.resume.update((r) => ({ ...r, experience: r.experience.filter((_, idx) => idx !== i) }));
    this.markDirty();
  }

  // ---------- certifications ----------
  addCertification(): void {
    this.resume.update((r) => ({ ...r, certifications: [...r.certifications, { name: '', year: '' }] }));
    this.markDirty();
  }
  updateCertification(i: number, field: string, v: string): void {
    this.resume.update((r) => ({ ...r, certifications: r.certifications.map((c, idx) => (idx === i ? { ...c, [field]: v } : c)) }));
    this.markDirty();
  }
  removeCertification(i: number): void {
    this.resume.update((r) => ({ ...r, certifications: r.certifications.filter((_, idx) => idx !== i) }));
    this.markDirty();
  }

  // ---------- skills ----------
  addSkill(raw: string): void {
    const s = raw.trim();
    if (!s) return;
    if (this.resume().skills.some((x) => x.toLowerCase() === s.toLowerCase())) {
      this.showToast('Already on your list.');
      return;
    }
    this.resume.update((r) => ({ ...r, skills: [...r.skills, s] }));
    this.markDirty();
  }
  removeSkill(i: number): void {
    this.resume.update((r) => ({ ...r, skills: r.skills.filter((_, idx) => idx !== i) }));
    this.markDirty();
  }
  onSkillKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const input = e.target as HTMLInputElement;
      this.addSkill(input.value);
      input.value = '';
    }
  }
  onSkillChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.value) {
      this.addSkill(input.value);
      input.value = '';
    }
  }

  // ---------- template ----------
  setTemplate(t: Template): void {
    this.resume.update((r) => ({ ...r, template: t }));
    this.markDirty();
  }

  // ---------- own file (dual-resume model) ----------
  formatSize(n: number): string {
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }
  formatUploadDate(ts: number): string {
    return new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  }

  async onFileSelected(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!this.resume().id) {
      const ok = await this.save(false);
      if (!ok) { input.value = ''; return; }
    }

    const res = await this.api.resumes.uploadFile(this.resume().id!, file);
    input.value = '';
    if (!res.ok) { this.showToast(res.error); return; }
    this.resume.update((r) => ({ ...r, ownFile: res.ownFile }));
    this.showToast('File attached. Recruiters will see it — the engine won’t.');
  }

  async removeOwnFile(): Promise<void> {
    const id = this.resume().id;
    if (!id) return;
    const res = await this.api.resumes.removeFile(id);
    if (!res.ok) { this.showToast(res.error); return; }
    this.resume.update((r) => ({ ...r, ownFile: null }));
    this.showToast('File removed.');
  }

  // ---------- save ----------
  async save(andLeave: boolean): Promise<boolean> {
    if (this.saving()) return false;
    this.formError.set(null);

    let r = this.resume();
    if (!r.title.trim()) {
      r = { ...r, title: 'Untitled resume' };
      this.resume.set(r);
    }
    if (!r.personal.fullName.trim()) {
      this.formError.set('Add your name before saving — it’s the first line of the resume.');
      this.goTo(0);
      return false;
    }

    this.saving.set(true);
    const res = await this.api.resumes.save(r);
    this.saving.set(false);

    if (!res.ok) {
      this.formError.set(res.error);
      return false;
    }

    this.resume.update((cur) => ({ ...cur, id: res.resume.id, ownFile: res.resume.ownFile }));
    this.dirty.set(false);
    this.savedFlag.set(true);
    this.router.navigate([], { relativeTo: this.route, queryParams: { id: res.resume.id }, replaceUrl: true });

    if (andLeave) {
      this.showToast('Resume saved. Scoring it now…');
      setTimeout(() => this.router.navigateByUrl('/seeker-dashboard'), 700);
    } else {
      this.showToast('Draft saved.');
    }
    return true;
  }

  // ---------- exports ----------
  private plainText(): string {
    const r = this.resume();
    const p = r.personal;
    const L: string[] = [];
    L.push(p.fullName || '', [p.email, p.phone, p.address].filter(Boolean).join(' | '), '');
    if (p.summary) L.push('SUMMARY', p.summary, '');
    if (r.education.length) {
      L.push('EDUCATION');
      r.education.forEach((e) => L.push('- ' + [e.degree, e.school, e.year].filter(Boolean).join(', ')));
      L.push('');
    }
    if (r.experience.length) {
      L.push('EXPERIENCE');
      r.experience.forEach((e) => {
        L.push('- ' + [e.position, e.company, e.months ? e.months + ' months' : ''].filter(Boolean).join(', '));
        if (e.description) L.push('  ' + e.description);
      });
      L.push('');
    }
    if (r.skills.length) L.push('SKILLS', r.skills.join(', '), '');
    if (r.certifications.length) {
      L.push('CERTIFICATIONS');
      r.certifications.forEach((c) => L.push('- ' + [c.name, c.year].filter(Boolean).join(', ')));
    }
    return L.join('\n');
  }

  private slug(): string {
    return (this.resume().personal.fullName || 'resume').replace(/[^a-z0-9]+/gi, '_');
  }

  private downloadBlob(blob: Blob, name: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private sectionHtml(title: string, itemsHtml: string): string {
    return itemsHtml ? `<div class="p-sec"><h2>${title}</h2>${itemsHtml}</div>` : '';
  }

  /** Builds the same section markup/order as the live-preview template,
   *  as a raw HTML string — used only for the Word export (option (a)
   *  from the task brief: build the target HTML directly rather than
   *  reading back rendered DOM). */
  private buildBlocksHtml(): string {
    const r = this.resume();
    const eduHtml = this.visibleEducation()
      .map((e) => `<div class="p-item"><b>${esc(e.degree || 'Degree')}</b><i>${esc(e.school || '')}${e.year ? ' · ' + esc(e.year) : ''}</i></div>`)
      .join('');
    const expHtml = this.visibleExperience()
      .map((e) => `<div class="p-item"><b>${esc(e.position || 'Position')}</b><i>${esc(e.company || '')}${e.months ? ' · ' + e.months + ' month' + (e.months > 1 ? 's' : '') : ''}</i>${e.description ? `<p>${esc(e.description)}</p>` : ''}</div>`)
      .join('');
    const skillHtml = r.skills.length ? `<div class="p-skills">${r.skills.map((s) => `<span>${esc(s)}</span>`).join('')}</div>` : '';
    const certHtml = this.visibleCertifications()
      .map((c) => `<div class="p-item"><b>${esc(c.name)}</b>${c.year ? `<i>${esc(c.year)}</i>` : ''}</div>`)
      .join('');

    const edu = this.sectionHtml('Education', eduHtml);
    const exp = this.sectionHtml('Experience', expHtml);
    const skill = this.sectionHtml('Skills', skillHtml);
    const cert = this.sectionHtml('Certifications', certHtml);

    if (r.template === 'functional') return skill + exp + edu + cert;
    if (r.template === 'combination') return skill + edu + exp + cert;
    return edu + exp + skill + cert;
  }

  exportTxt(): void {
    this.downloadBlob(new Blob([this.plainText()], { type: 'text/plain' }), this.slug() + '.txt');
    this.showToast('Text file downloaded.');
  }

  exportWord(): void {
    const r = this.resume();
    const p = r.personal;
    const name = esc(p.fullName) || 'Your name';
    const contact = esc(this.contactLine()) || 'email · phone · city';
    const summary = p.summary ? `<div class="p-sec"><h2>Summary</h2><p style="font-size:11.5px">${esc(p.summary)}</p></div>` : '';
    const ownFileNote = r.ownFile
      ? `<div class="p-sec"><h2>Attached by the applicant</h2><p style="font-size:11px;color:#5A5F6B">${esc(r.ownFile.name)} — sent to the recruiter alongside this resume. Not part of the score.</p></div>`
      : '';

    const html =
      '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">' +
      '<style>body{font-family:Georgia,serif;font-size:11pt;line-height:1.4}h1{font-size:18pt;margin:0}' +
      'h2{font-size:10pt;letter-spacing:1.5px;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:2px;margin:16pt 0 6pt}' +
      '.c{font-size:9pt;color:#555}</style></head><body>' +
      `<h1>${name}</h1><p class="c">${contact}</p>${summary}${this.buildBlocksHtml()}${ownFileNote}</body></html>`;

    this.downloadBlob(new Blob(['﻿' + html], { type: 'application/msword' }), this.slug() + '.doc');
    this.showToast('Word file downloaded.');
  }

  async exportPdf(): Promise<void> {
    if (this.dirty() || !this.resume().id) {
      const ok = await this.save(false);
      if (!ok) return;
    }
    window.open('/resume-print?id=' + this.resume().id, '_blank');
  }

  // ---------- toast ----------
  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
