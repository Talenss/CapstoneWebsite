import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { AnalysisService } from '../../core/analysis.service';
import { TourService } from '../../shared/tour/tour.service';
import { DESIGN_ORDER, EDU_LABELS } from '../../core/engine';
import { Education, EduLevel, Experience, Language, Project, Reference, Resume, ResumeDesign, Template } from '../../core/models';

const STEPS = ['Details', 'Education', 'Experience', 'Skills', 'Certifications', 'More sections', 'Finish'];

type SectionKind = 'education' | 'experience' | 'skills' | 'projects' | 'certifications';

/** Skills that no Royce opening happens to ask for right now, offered so the
 *  list isn't limited to what the demand pool contains. They score nothing
 *  today and the copy says so — but a resume is read by people too, and next
 *  month's opening may well ask for one of them. */
const OTHER_SKILLS = [
  'Cash Handling', 'Inventory', 'Bartending', 'Barista Skills', 'Housekeeping', 'Front Desk',
  'Event Coordination', 'Booking Systems', 'Bookkeeping', 'Payroll', 'Data Entry', 'Filing',
  'Google Workspace', 'Excel', 'Canva', 'Photoshop', 'Photography', 'Video Editing',
  'Copywriting', 'Public Speaking', 'Tutoring', 'Driving (Professional License)',
  'Basic Electrical', 'Carpentry', 'Sewing', 'Baking', 'First Aid', 'Sign Language',
];

function blankResume(id: string | null = null): Resume {
  return {
    id,
    title: '',
    template: 'chronological',
    design: 'classic',
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
  imports: [Header, Footer, NgTemplateOutlet, RouterLink],
  templateUrl: './resume-builder.html',
  styleUrl: './resume-builder.css',
})
export class ResumeBuilder implements OnInit {
  private api = inject(ApiService);
  private session = inject(SessionService);
  private analysis = inject(AnalysisService);
  private tour = inject(TourService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private sanitizer = inject(DomSanitizer);

  /** The original file from the Upload & Analyze flow, attached to the
   *  resume as the recruiter-visible "own file" after the first save. */
  private pendingAnalysisFile: File | null = null;

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
  visibleProjects = computed(() => (this.resume().projects ?? []).filter((p) => !!p.name));
  visibleLanguages = computed(() => (this.resume().languages ?? []).filter((l) => !!l.name));
  visibleReferences = computed(() => (this.resume().references ?? []).filter((r) => !!r.name));
  poolSuggestions = computed(() => {
    const have = new Set(this.resume().skills.map((s) => s.toLowerCase()));
    return this.poolAll().filter((s) => !have.has(s.toLowerCase()));
  });
  /** The second pool: not in demand today, not already on the list. */
  otherSuggestions = computed(() => {
    const have = new Set([
      ...this.resume().skills.map((s) => s.toLowerCase()),
      ...this.poolAll().map((s) => s.toLowerCase()),
    ]);
    return OTHER_SKILLS.filter((s) => !have.has(s.toLowerCase()));
  });

  /** Section order for the live preview. Normally the Template decides; the
   *  'graduate' and 'technical' designs exist for the order they impose, so
   *  they win — and `designReorders` drives the on-screen note that says so,
   *  rather than leaving the Template radio looking live when it isn't. */
  designReorders = computed(() => !!DESIGN_ORDER[this.resume().design]);
  sectionOrder = computed<SectionKind[]>(() => {
    const forced = DESIGN_ORDER[this.resume().design];
    if (forced) return forced as SectionKind[];
    const t = this.resume().template;
    if (t === 'functional') return ['skills', 'experience', 'education', 'projects', 'certifications'];
    if (t === 'combination') return ['skills', 'education', 'experience', 'projects', 'certifications'];
    return ['education', 'experience', 'skills', 'projects', 'certifications'];
  });
  checklist = computed(() => {
    const r = this.resume();
    return [
      { label: 'Your name and a way to contact you', done: !!(r.personal.fullName && (r.personal.email || r.personal.phone)), optional: false },
      { label: 'A short summary', done: (r.personal.summary || '').trim().length >= 20, optional: false },
      { label: 'At least one education entry', done: r.education.length > 0, optional: false },
      { label: 'At least three skills', done: r.skills.length >= 3, optional: false },
      { label: 'Experience (optional — many openings ask for none)', done: r.experience.length > 0, optional: true },
      { label: 'Projects, languages or references (optional)', done: !!(r.projects?.length || r.languages?.length || r.references?.length), optional: true },
      { label: 'Your own resume file (optional)', done: !!r.ownFile, optional: true },
    ];
  });
  fileUrl = computed(() => {
    const r = this.resume();
    if (!r.ownFile) return null;
    return r.id ? this.api.resumes.fileUrl(r.id) : r.ownFile.dataUrl || null;
  });

  /* ---- the attached file, shown in the preview ----
     The preview used to name the attached file and stop there, so the one
     thing the applicant could not check was the document the recruiter would
     actually open. It is rendered here the same way the recruiter's screen
     renders it — PDF in a frame, image inline, Word as a note, because no
     browser previews .docx — and deliberately OUTSIDE the sheet: it is a
     second document sent alongside, not part of the one being printed. */
  ownFileKind = computed<'pdf' | 'image' | 'other' | null>(() => {
    const f = this.resume().ownFile;
    if (!f) return null;
    if (f.mime === 'application/pdf') return 'pdf';
    if (f.mime.startsWith('image/')) return 'image';
    return 'other';
  });

  /** An <iframe src> is a trusted-resource-URL context, so Angular blocks a
   *  plain string. The URL is our own /api/file endpoint or a data: URL this
   *  same browser just produced from the user's own file — never third-party
   *  input — so trusting it is safe here and nowhere wider. */
  ownFileFrameUrl = computed<SafeResourceUrl | null>(() => {
    const url = this.fileUrl();
    return url ? this.sanitizer.bypassSecurityTrustResourceUrl(url) : null;
  });

  async ngOnInit(): Promise<void> {
    const user = this.session.user()!;
    const id = this.route.snapshot.queryParamMap.get('id');
    const welcome = this.route.snapshot.queryParamMap.get('welcome');

    const fromAnalysis = this.route.snapshot.queryParamMap.get('from') === 'analysis';
    const pending = fromAnalysis && !id ? this.analysis.take() : null;

    if (id) {
      const res = await this.api.resumes.get(id);
      if (!res.ok) {
        this.router.navigateByUrl('/my-resumes', { replaceUrl: true });
        return;
      }
      this.resume.set(res.resume);
    } else if (pending) {
      // Prefill from the Upload & Analyze extraction. Nothing is saved yet —
      // this is exactly the review step the consent text promised.
      const d = pending.data;
      this.resume.set({
        ...blankResume(),
        title: d.title || 'Uploaded resume',
        template: d.template || 'chronological',
        design: d.design || 'classic',
        personal: {
          fullName: d.personal.fullName || user.name,
          email: d.personal.email || user.email,
          phone: d.personal.phone || '',
          address: d.personal.address || '',
          summary: d.personal.summary || '',
          ...(d.personal.headline ? { headline: d.personal.headline } : {}),
          ...(d.personal.linkedin ? { linkedin: d.personal.linkedin } : {}),
          ...(d.personal.portfolio ? { portfolio: d.personal.portfolio } : {}),
        },
        education: d.education,
        experience: d.experience,
        skills: d.skills,
        certifications: d.certifications,
        // Only what the upload actually contained — an absent section stays
        // absent so the builder doesn't open on an empty heading to delete.
        ...(d.projects?.length ? { projects: d.projects } : {}),
        ...(d.languages?.length ? { languages: d.languages } : {}),
        ...(d.references?.length ? { references: d.references } : {}),
      });
      this.pendingAnalysisFile = pending.file;
      this.dirty.set(true);
      this.showToast(
        pending.simulated
          ? 'Prefilled from a simulated analysis (demo mode) — review each step, then save.'
          : 'We filled this in from your uploaded resume — review each step before saving.',
      );
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
        { sel: '#rail', title: 'Seven steps, in order', text: 'Move with Next, or jump straight to any step. Steps 1–5 are the resume itself; “More sections” is optional extras. Nothing is scored until you save, and you can come back and edit forever.' },
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

  /** Read by the route's canDeactivate guard. `beforeunload` above only
   *  covers closing or reloading the tab; clicking a link in the header is a
   *  route change, which fires no such event and used to bin unsaved work
   *  without a word. */
  hasUnsavedChanges(): boolean {
    return this.dirty();
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
  updateExperience(
    i: number,
    field: 'position' | 'company' | 'months' | 'description' | 'location' | 'startDate' | 'endDate',
    v: string,
  ): void {
    this.resume.update((r) => ({
      ...r,
      experience: r.experience.map((exp, idx): Experience => {
        if (idx !== i) return exp;
        if (field === 'months') return { ...exp, months: Number(v) || 0 };
        return { ...exp, [field]: v };
      }),
    }));
    this.markDirty();
  }
  /** "I still work here" — clears the end date, since the sheet prints
   *  "Present" for it and two answers would contradict each other. */
  toggleCurrent(i: number, on: boolean): void {
    this.resume.update((r) => ({
      ...r,
      experience: r.experience.map((exp, idx) => (idx === i ? { ...exp, current: on, endDate: on ? '' : exp.endDate } : exp)),
    }));
    this.markDirty();
  }
  /** Bullets are edited as one textarea, one line each — the same shape they
   *  are stored and printed in, so nothing can be lost in translation. */
  bulletText(e: Experience): string {
    return (e.bullets ?? []).join('\n');
  }
  updateBullets(i: number, v: string): void {
    const bullets = v.split('\n').map((b) => b.trim()).filter(Boolean);
    this.resume.update((r) => ({
      ...r,
      experience: r.experience.map((exp, idx) => (idx === i ? { ...exp, bullets } : exp)),
    }));
    this.markDirty();
  }
  removeExperience(i: number): void {
    this.resume.update((r) => ({ ...r, experience: r.experience.filter((_, idx) => idx !== i) }));
    this.markDirty();
  }

  // ---------- projects / languages / references ----------
  // All three are optional. An empty list is stored as no list at all, so a
  // resume that has none prints no heading — matching what the server returns.
  addProject(): void {
    this.resume.update((r) => ({ ...r, projects: [...(r.projects ?? []), { name: '' } as Project] }));
    this.markDirty();
  }
  updateProject(i: number, field: string, v: string): void {
    this.resume.update((r) => ({ ...r, projects: (r.projects ?? []).map((p, idx) => (idx === i ? { ...p, [field]: v } : p)) }));
    this.markDirty();
  }
  removeProject(i: number): void {
    this.resume.update((r) => ({ ...r, projects: (r.projects ?? []).filter((_, idx) => idx !== i) }));
    this.markDirty();
  }

  addLanguage(): void {
    this.resume.update((r) => ({ ...r, languages: [...(r.languages ?? []), { name: '' } as Language] }));
    this.markDirty();
  }
  updateLanguage(i: number, field: string, v: string): void {
    this.resume.update((r) => ({ ...r, languages: (r.languages ?? []).map((l, idx) => (idx === i ? { ...l, [field]: v } : l)) }));
    this.markDirty();
  }
  removeLanguage(i: number): void {
    this.resume.update((r) => ({ ...r, languages: (r.languages ?? []).filter((_, idx) => idx !== i) }));
    this.markDirty();
  }

  addReference(): void {
    this.resume.update((r) => ({ ...r, references: [...(r.references ?? []), { name: '' } as Reference] }));
    this.markDirty();
  }
  updateReference(i: number, field: string, v: string): void {
    this.resume.update((r) => ({ ...r, references: (r.references ?? []).map((x, idx) => (idx === i ? { ...x, [field]: v } : x)) }));
    this.markDirty();
  }
  removeReference(i: number): void {
    this.resume.update((r) => ({ ...r, references: (r.references ?? []).filter((_, idx) => idx !== i) }));
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

  // ---------- template (section order) ----------
  setTemplate(t: Template): void {
    this.resume.update((r) => ({ ...r, template: t }));
    this.markDirty();
  }

  // ---------- design (visual style) — every option is single-column, ATS-safe ----------
  readonly designs: { id: ResumeDesign; label: string; note: string; suits: string }[] = [
    { id: 'classic', label: 'Classic', note: 'Serif, centered', suits: 'Government, banking, legal, education' },
    { id: 'modern', label: 'Modern', note: 'Sans, gold accent', suits: 'Hospitality, marketing, front office' },
    { id: 'minimal', label: 'Minimal', note: 'Airy, light', suits: 'Design, media, start-ups' },
    { id: 'executive', label: 'Executive', note: 'Serif, formal', suits: 'Supervisory and management roles' },
    { id: 'banner', label: 'Banner', note: 'Dark header band', suits: 'Sales, events, customer-facing roles' },
    { id: 'split', label: 'Split', note: 'Name / contact split', suits: 'Administration, coordination' },
    { id: 'bar', label: 'Bar', note: 'Filled headings', suits: 'Retail, operations, logistics' },
    { id: 'categorized', label: 'Rail', note: 'Left accent rail', suits: 'Any role wanting a little colour' },
    // The six added to the ATS set. Names differ from the brief's so they
    // don't collide with the eight above ("Classic" and "Executive" were
    // already taken by a different look).
    { id: 'traditional', label: 'Traditional', note: 'Georgia, thin rules', suits: 'The most conservative employers' },
    { id: 'clean', label: 'Clean', note: 'No rules, whitespace only', suits: 'Corporate roles, modern HR teams' },
    { id: 'compact', label: 'Compact', note: 'Tight — fits more on a page', suits: 'Long histories that must stay on one page' },
    { id: 'senior', label: 'Senior', note: 'Big name block + headline', suits: 'Department heads, senior applicants' },
    { id: 'graduate', label: 'Graduate', note: 'Education first', suits: 'Fresh graduates and OJT applicants' },
    { id: 'technical', label: 'Technical', note: 'Skills and projects first', suits: 'IT, engineering, technical roles' },
  ];

  setDesign(d: ResumeDesign): void {
    this.resume.update((r) => ({ ...r, design: d }));
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
    // What we are actually sending. Compared against the live signal after
    // the round trip: anything typed WHILE the request was in flight is not
    // in this payload, so marking the form clean would discard those
    // characters silently — and the unsaved-changes guard would not fire
    // either, because it only watches `dirty`.
    const sent = JSON.stringify(r);
    const res = await this.api.resumes.save(r);
    this.saving.set(false);

    if (!res.ok) {
      this.formError.set(res.error);
      return false;
    }

    this.resume.update((cur) => ({ ...cur, id: res.resume.id, ownFile: res.resume.ownFile }));
    // Only clean if nothing changed under us. If it did, the newer edits are
    // still unsaved and the form must keep saying so.
    const changedDuringSave = JSON.stringify({
      ...this.resume(), id: r.id, ownFile: r.ownFile,
    }) !== sent;
    this.dirty.set(changedDuringSave);
    this.savedFlag.set(true);
    this.router.navigate([], { relativeTo: this.route, queryParams: { id: res.resume.id }, replaceUrl: true });

    // Upload & Analyze flow: attach the original uploaded file to the saved
    // resume as the recruiter-visible copy (dual-resume model). One attempt —
    // if it fails, the user can attach it manually on the Finish step.
    if (this.pendingAnalysisFile && !this.resume().ownFile) {
      const file = this.pendingAnalysisFile;
      this.pendingAnalysisFile = null;
      const up = await this.api.resumes.uploadFile(res.resume.id!, file);
      if (up.ok) {
        this.resume.update((cur) => ({ ...cur, ownFile: up.ownFile }));
        this.showToast('Saved — and your original file is attached for recruiters to read.');
      }
    }

    if (andLeave) {
      this.showToast('Resume saved. Scoring it now…');
      setTimeout(() => this.router.navigateByUrl('/seeker-dashboard'), 700);
    } else {
      this.showToast('Draft saved.');
    }
    return true;
  }

  /** Joins the optional bits of a line, dropping the empty ones. Template
   *  expressions can't reach the global `Boolean`, so the filtering has to
   *  happen here rather than inline in the HTML. */
  joinMeta(parts: (string | undefined | null)[], sep = ' · '): string {
    return parts.map((x) => (x ?? '').trim()).filter((x) => x !== '').join(sep);
  }
  monthsLabel(months: number): string {
    return months ? `${months} month${months > 1 ? 's' : ''}` : '';
  }
  languageLine(): string {
    return this.visibleLanguages().map((l) => this.joinMeta([l.name, l.proficiency], ' — ')).join('  ·  ');
  }

  /** "Jun 2025 – Present" / "Jun 2024 – Mar 2025". One format everywhere, so
   *  a parser reading dates out of the sheet sees the same shape each time. */
  dateRange(e: { startDate?: string; endDate?: string; current?: boolean }): string {
    const from = (e.startDate || '').trim();
    const to = e.current ? 'Present' : (e.endDate || '').trim();
    if (from && to) return `${from} – ${to}`;
    return from || to || '';
  }

  // ---------- exports ----------
  private plainText(): string {
    const r = this.resume();
    const p = r.personal;
    const L: string[] = [];
    L.push(p.fullName || '');
    if (p.headline) L.push(p.headline);
    // Links go in as their full visible URL: a parser that drops the anchor
    // still keeps the address.
    L.push([p.email, p.phone, p.address, p.linkedin, p.portfolio].filter(Boolean).join(' | '), '');
    if (p.summary) L.push('PROFESSIONAL SUMMARY', p.summary, '');
    if (r.education.length) {
      L.push('EDUCATION');
      r.education.forEach((e) => {
        L.push('- ' + [e.degree, e.field, e.school, e.location, e.year].filter(Boolean).join(', '));
        if (e.honors) L.push('  ' + e.honors);
      });
      L.push('');
    }
    if (r.experience.length) {
      L.push('WORK EXPERIENCE');
      r.experience.forEach((e) => {
        L.push('- ' + [e.position, e.company, e.location, this.dateRange(e) || (e.months ? e.months + ' months' : '')].filter(Boolean).join(', '));
        if (e.description) L.push('  ' + e.description);
        (e.bullets ?? []).forEach((b) => L.push('  - ' + b));
      });
      L.push('');
    }
    if (r.skills.length) L.push('SKILLS', r.skills.join(', '), '');
    if (r.projects?.length) {
      L.push('PROJECTS');
      r.projects.forEach((x) => {
        L.push('- ' + [x.name, x.role, this.dateRange(x)].filter(Boolean).join(', '));
        if (x.description) L.push('  ' + x.description);
        if (x.link) L.push('  ' + x.link);
      });
      L.push('');
    }
    if (r.certifications.length) {
      L.push('CERTIFICATIONS');
      r.certifications.forEach((c) => L.push('- ' + [c.name, c.issuer, c.year, c.credentialId].filter(Boolean).join(', ')));
      L.push('');
    }
    if (r.languages?.length) {
      L.push('LANGUAGES', r.languages.map((l) => [l.name, l.proficiency].filter(Boolean).join(' — ')).join(', '), '');
    }
    if (r.references?.length) {
      L.push('REFERENCES');
      r.references.forEach((x) => L.push('- ' + [x.name, x.position, x.company, x.email, x.phone].filter(Boolean).join(', ')));
    }
    return L.join('\n').trimEnd();
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
   *  reading back rendered DOM). Headings are the standard ATS ones, spelled
   *  the same here, in the preview, and on the print sheet. */
  private buildBlocksHtml(): string {
    const r = this.resume();
    const meta = (parts: (string | undefined)[]) => parts.filter(Boolean).map((x) => esc(x)).join(' · ');

    const eduHtml = this.visibleEducation()
      .map((e) => `<div class="p-item"><b>${esc([e.degree || 'Degree', e.field].filter(Boolean).join(' — '))}</b>`
        + `<i>${meta([e.school, e.location, e.year])}</i>${e.honors ? `<p>${esc(e.honors)}</p>` : ''}</div>`)
      .join('');
    const expHtml = this.visibleExperience()
      .map((e) => `<div class="p-item"><b>${esc(e.position || 'Position')}</b>`
        + `<i>${meta([e.company, e.location, this.dateRange(e) || (e.months ? e.months + ' month' + (e.months > 1 ? 's' : '') : '')])}</i>`
        + `${e.description ? `<p>${esc(e.description)}</p>` : ''}`
        + `${(e.bullets ?? []).length ? `<ul>${(e.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}</div>`)
      .join('');
    const skillHtml = r.skills.length ? `<p>${esc(r.skills.join(' · '))}</p>` : '';
    const projHtml = this.visibleProjects()
      .map((x) => `<div class="p-item"><b>${esc(x.name)}</b><i>${meta([x.role, this.dateRange(x)])}</i>`
        + `${x.description ? `<p>${esc(x.description)}</p>` : ''}${x.link ? `<p>${esc(x.link)}</p>` : ''}</div>`)
      .join('');
    const certHtml = this.visibleCertifications()
      .map((c) => `<div class="p-item"><b>${esc(c.name)}</b><i>${meta([c.issuer, c.year])}</i>`
        + `${c.credentialId ? `<p>${esc(c.credentialId)}</p>` : ''}</div>`)
      .join('');
    const langHtml = this.visibleLanguages().length
      ? `<p>${esc(this.visibleLanguages().map((l) => [l.name, l.proficiency].filter(Boolean).join(' — ')).join(' · '))}</p>` : '';
    const refHtml = this.visibleReferences()
      .map((x) => `<div class="p-item"><b>${esc(x.name)}</b><i>${meta([x.position, x.company])}</i>`
        + `${x.email || x.phone ? `<p>${meta([x.email, x.phone])}</p>` : ''}</div>`)
      .join('');

    const block: Record<SectionKind, string> = {
      education: this.sectionHtml('Education', eduHtml),
      experience: this.sectionHtml('Work Experience', expHtml),
      skills: this.sectionHtml('Skills', skillHtml),
      projects: this.sectionHtml('Projects', projHtml),
      certifications: this.sectionHtml('Certifications', certHtml),
    };
    // Languages and References always close the document, whatever the order
    // above — that is where a reader expects them.
    return this.sectionOrder().map((k) => block[k]).join('')
      + this.sectionHtml('Languages', langHtml)
      + this.sectionHtml('References', refHtml);
  }

  exportTxt(): void {
    this.downloadBlob(new Blob([this.plainText()], { type: 'text/plain' }), this.slug() + '.txt');
    this.showToast('Text file downloaded.');
  }

  exportWord(): void {
    const r = this.resume();
    const p = r.personal;
    const name = esc(p.fullName) || 'Your name';
    const headline = p.headline ? `<p class="hl">${esc(p.headline)}</p>` : '';
    const contact = esc(this.contactLine()) || 'email · phone · city';
    const links = [p.linkedin, p.portfolio].filter(Boolean).map((x) => esc(x)).join(' · ');
    const summary = p.summary ? `<div class="p-sec"><h2>Professional Summary</h2><p style="font-size:11.5px">${esc(p.summary)}</p></div>` : '';
    const ownFileNote = r.ownFile
      ? `<div class="p-sec"><h2>Attached by the applicant</h2><p style="font-size:11px;color:#5A5F6B">${esc(r.ownFile.name)} — sent to the recruiter alongside this resume. Not part of the score.</p></div>`
      : '';

    const html =
      '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">' +
      // Word gets ATS-safe system fonts too — a downloaded face would not
      // survive the .doc anyway, and Georgia/Arial are on every machine.
      '<style>body{font-family:Georgia,"Times New Roman",serif;font-size:11pt;line-height:1.4}h1{font-size:18pt;margin:0}' +
      'h2{font-family:Arial,Helvetica,sans-serif;font-size:10pt;letter-spacing:1.5px;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:2px;margin:16pt 0 6pt}' +
      'ul{margin:3pt 0 0 16pt;padding:0}li{font-size:10.5pt}' +
      '.c,.hl{font-size:9.5pt;color:#555}</style></head><body>' +
      `<h1>${name}</h1>${headline}<p class="c">${contact}</p>${links ? `<p class="c">${links}</p>` : ''}` +
      `${summary}${this.buildBlocksHtml()}${ownFileNote}</body></html>`;

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
