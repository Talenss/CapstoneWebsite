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
import { DESIGN_ORDER, EDU_LABELS, EVIDENCE_KINDS, EVIDENCE_KIND_LABELS, evidenceLabels, evidenceSources, visibleResume, WEIGHTS, DEGREE_CATALOGUE, SKILL_CATALOGUE, MAX_RESUMES, emailProblem, phoneProblem, linkedinProblem, experienceInPrintOrder } from '../../core/engine';
import { Education, EduLevel, EvidenceKind, Experience, Language, Project, Reference, Resume, ResumeDesign, ResumeLink, ResumeSection, SkillEvidence, Template } from '../../core/models';
import { HlmSelectImports } from '@spartan-ng/helm/select';

const STEPS = ['Details', 'Education', 'Experience', 'Skills', 'Certifications', 'More sections', 'Finish'];

type SectionKind = 'education' | 'experience' | 'skills' | 'projects' | 'certifications';

/** Skills that no Clark Outsourcing opening happens to ask for right now, offered so the
 *  list isn't limited to what the demand pool contains. They score nothing
 *  today and the copy says so — but a resume is read by people too, and next
 *  month's opening may well ask for one of them. */
const OTHER_SKILLS = [
  'Google Workspace', 'Excel', 'Payroll', 'Filing', 'Typing Speed', 'Transcription',
  'Live Chat Support', 'Email Support', 'Appointment Setting', 'Lead Generation',
  'Technical Writing', 'Public Speaking', 'Tutoring', 'Photoshop', 'Photography',
  'Video Editing', 'Adobe Illustrator', 'Project Management', 'SEO', 'Google Analytics',
  'Salesforce', 'Xero', 'Basic Accounting', 'Inventory', 'Cash Handling', 'First Aid',
  'Sign Language', 'Driving (Professional License)',
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

/** Port of the PHP resume-builder.html — the 6-step guided
 *  resume wizard with a live document preview. The original leaned on
 *  a generic repeat() DOM-builder and manual paint()/innerHTML calls
 *  on every keystroke; here the whole `resume` signal drives real
 *  Angular templates (form sections + the preview pane) directly, so
 *  there's nothing to manually repaint. */
@Component({
  selector: 'app-resume-builder',
  standalone: true,
  imports: [Header, Footer, NgTemplateOutlet, RouterLink, ...HlmSelectImports],
  templateUrl: './resume-builder.html',
  styleUrl: './resume-builder.css',
})
export class ResumeBuilder implements OnInit {
  /** Read, never restated — the split is a row in match_settings. */
  readonly WEIGHTS = WEIGHTS;
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
  /** True when this visit STARTED a new resume (no id in the URL) — built from
   *  scratch or from an uploaded file. Such a resume becomes the active one
   *  when the applicant finishes it; editing an existing resume never moves
   *  "active" on its own. */
  private createdHere = false;

  /** The skills the analyzer read OUT of that file, kept from the prefill so
   *  they can be credited to it once it is attached. Skills typed by hand
   *  afterwards are not in here and are not credited: the document is a
   *  source for what it actually contains, nothing more. */
  private importedSkills: string[] = [];

  readonly STEPS = STEPS;
  /** Autocomplete for the degree field. A shortcut, not a closed list:
   *  anything typed by hand is still placed by the field vocabulary. */
  readonly DEGREE_CATALOGUE = DEGREE_CATALOGUE;
  readonly eduLevelLabel = (v: string): string =>
    this.eduLevelOptions.find((o) => o.value === v)?.label ?? String(v ?? '');

  readonly eduLevelOptions: { value: EduLevel; label: string }[] = [
    // The starting state of a new entry, and a real answer in its own right.
    // Listed so the applicant can SEE that nothing is being claimed for them.
    { value: 'none', label: 'Not stated yet' },
    { value: 'highschool', label: EDU_LABELS.highschool },
    { value: 'vocational', label: EDU_LABELS.vocational },
    { value: 'associate', label: EDU_LABELS.associate },
    { value: 'college_level', label: EDU_LABELS.college_level },
    { value: 'bachelor', label: EDU_LABELS.bachelor },
    { value: 'master', label: EDU_LABELS.master },
  ];

  ready = signal(false);
  resume = signal<Resume>(blankResume());
  step = signal(0);
  /** Has the applicant actually SEEN the skills step?
   *
   *  This is the signal behind evidence_prompted on the server, and it has to
   *  be this rather than "did the payload happen to carry a skillEvidence
   *  key". addSkill() does not create that key — only setting a source or
   *  removing a skill does — so keying on its presence meant an applicant who
   *  typed the four skills a posting asks for and linked none of them looked
   *  like one who was never asked, and scored 100 where the published rule
   *  says 75. That is precisely the padding the half-credit rule exists to
   *  make expensive.
   *
   *  Reaching the step IS being asked: the source picker sits beside every
   *  skill on it. An import that is saved from an earlier step has not been
   *  asked, and keeps full credit until the applicant gets there. */
  evidenceAsked = signal(false);
  dirty = signal(false);
  saving = signal(false);
  savedFlag = signal(false);
  formError = signal<string | null>(null);

  /** Every OTHER resume this applicant owns, id and title. Loaded once so the
   *  title field can say "taken" while it is being typed rather than after a
   *  round trip. The server is what actually enforces it. */
  private otherTitles = signal<{ id: string | null; title: string }[]>([]);

  readonly MAX_RESUMES = MAX_RESUMES;

  /* Contact details, checked as they are typed — the same rules the server
     binds (lib/contact.ts), so what the field accepts is what saves. Null
     while blank: "email or phone" is its own rule, and a field someone has
     not reached yet is not an error. */
  emailErr = computed(() => emailProblem(this.resume().personal.email));
  phoneErr = computed(() => phoneProblem(this.resume().personal.phone));
  linkedinErr = computed(() => linkedinProblem(this.resume().personal.linkedin));
  /** The resume's name is required: it is what the applicant picks from when
   *  applying, and what the recruiter sees beside the application. */
  titleMissing = computed(() => !this.resume().title.trim());
  /** A NEW resume when the applicant already holds the most they can keep.
   *  Said at the top of the builder from the start, so nobody fills in seven
   *  steps only to be refused at the end. Editing an existing one is never
   *  affected. otherTitles holds every resume they own. */
  atResumeLimit = computed(() => !this.resume().id && this.otherTitles().length >= MAX_RESUMES);

  /** True while the title matches another of this applicant's resumes. Excluded
   *  by id, so a saved resume never clashes with itself. */
  titleClash = computed(() => {
    const r = this.resume();
    const t = r.title.trim().toLowerCase();
    if (!t) return false;
    return this.otherTitles().some((o) => o.id !== r.id && o.title.trim().toLowerCase() === t);
  });

  /** `base`, or the first of "base 2", "base 3" ... that is free. Used for
   *  every title the builder writes on the applicant's behalf: "My resume" is
   *  the default for a NEW resume, so without this a second resume would open
   *  already clashing and refuse to save with an error the applicant did not
   *  cause. */
  private freeTitle(base: string): string {
    const taken = new Set(this.otherTitles().map((o) => o.title.trim().toLowerCase()));
    if (!taken.has(base.trim().toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }
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
  /** The live preview's order: jobs still held first, as every printed copy
   *  has them. The step's own list keeps the order the applicant typed. */
  previewExperience = computed(() => experienceInPrintOrder(this.visibleExperience()));
  /* A switched-off section is empty HERE too, not only on the saved sheet.
     The preview beside the form is the applicant's only view of what the
     recruiter will get; if hiding a section left it standing in the preview,
     the switch would look broken and they would untick it again. */
  visibleCertifications = computed(() => this.isHidden('certifications')
    ? [] : this.resume().certifications.filter((c) => c.name));
  visibleProjects = computed(() => this.isHidden('projects')
    ? [] : (this.resume().projects ?? []).filter((p) => !!p.name));
  visibleLanguages = computed(() => this.isHidden('languages')
    ? [] : (this.resume().languages ?? []).filter((l) => !!l.name));
  visibleReferences = computed(() => this.isHidden('references')
    ? [] : (this.resume().references ?? []).filter((r) => !!r.name));
  visibleSummary = computed(() => this.isHidden('summary') ? '' : this.resume().personal.summary);
  /** What is already on the resume, lower-cased. The two suggestion pools
   *  consult this to draw a chip's state — never to decide whether the chip
   *  is there at all. Removing chosen chips reflowed the rows under the
   *  user's cursor, so a second click in a quick sequence landed on whatever
   *  had slid into that spot; on the list that carries 50% of the score,
   *  that silently changed the score without the user noticing. */
  private listedSkills = computed(() => new Set(this.resume().skills.map((s) => s.toLowerCase())));
  skillListed = (s: string): boolean => this.listedSkills().has(s.toLowerCase());

  /** The second pool: skills no open posting asks for. Fixed once the
   *  postings have loaded, and deliberately not filtered by what the user
   *  has chosen — so nothing here moves while they are choosing either. */
  otherSuggestions = computed(() => {
    const demanded = new Set(this.poolAll().map((s) => s.toLowerCase()));
    return OTHER_SKILLS.filter((s) => !demanded.has(s.toLowerCase()));
  });

  /** What the type-ahead offers. The two pools above are what we SUGGEST —
   *  they stay small on purpose. This is what we RECOGNISE, and it is the
   *  whole catalogue, so someone who already knows they have "Phlebotomy"
   *  can type three letters and take the spelling the scorer expects instead
   *  of guessing at it. Offering a skill here is not a hint that it is worth
   *  claiming: the list is alphabetical and every entry is equally inert
   *  until a posting asks for it. Typing something outside the catalogue is
   *  still allowed — the input is free text and always was. */
  skillOptions = computed(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of [...SKILL_CATALOGUE.map((c) => c.name), ...this.poolAll(), ...OTHER_SKILLS]) {
      const key = s.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(s.trim());
    }
    return out.sort((a, b) => a.localeCompare(b));
  });

  /** Every skill in demand is now on the resume. Said as a note beside the
   *  chips rather than in place of them, because the chips still have a job:
   *  they are how you take one back off. */
  allDemandedListed = computed(() => {
    const pool = this.poolAll();
    return pool.length > 0 && pool.every((s) => this.listedSkills().has(s.toLowerCase()));
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
      /* Tests CONTENT, not the existence of an entry object. An entry with
         every field blank used to satisfy this, so a resume could be called
         ready on the strength of a row nobody had typed into. The school
         name is the evidence the entry is real; the level beside it is what
         actually reaches the score. */
      { label: 'An education entry with the school filled in',
        done: r.education.some((e) => (e.school || '').trim() !== ''), optional: false },
      { label: 'At least three skills', done: r.skills.length >= 3, optional: false },
      { label: 'Experience (optional, many openings ask for none)', done: r.experience.length > 0, optional: true },
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

  /** What happened when software tried to read the attached file. Written so
   *  "we could not read it" never reads like "it scored badly" — those mean
   *  opposite things, and only one of them is about the applicant. */
  fileStatusLabel = computed(() => {
    switch (this.resume().ownFile?.extractStatus) {
      case 'ok':          return 'read and scored';
      case 'unavailable': return 'not read, automatic reading is off here';
      case 'unreadable':  return "not read: this format can't be opened by software";
      case 'failed':      return 'could not be read automatically';
      default:            return 'read by the recruiter';
    }
  });
  readByMachine = computed(() => this.resume().ownFile?.extractStatus === 'ok');

  /** An <iframe src> is a trusted-resource-URL context, so Angular blocks a
   *  plain string. The URL is our own /api/file endpoint or a data: URL this
   *  same browser just produced from the user's own file — never third-party
   *  input — so trusting it is safe here and nowhere wider. */
  ownFileFrameUrl = computed<SafeResourceUrl | null>(() => {
    const url = this.fileUrl();
    if (!url) return null;
    // Same as the recruiter's frame: the viewer's toolbar prints the source
    // URL as a title, which for a demo-mode data: URL is a screenful of
    // base64. The file name is shown beneath the frame instead.
    return this.sanitizer.bypassSecurityTrustResourceUrl(url + '#toolbar=0&navpanes=0&statusbar=0&view=FitH');
  });

  async ngOnInit(): Promise<void> {
    const user = this.session.user()!;
    const id = this.route.snapshot.queryParamMap.get('id');
    this.createdHere = !id;
    const welcome = this.route.snapshot.queryParamMap.get('welcome');

    const fromAnalysis = this.route.snapshot.queryParamMap.get('from') === 'analysis';
    const pending = fromAnalysis && !id ? this.analysis.take() : null;

    // Before the branch below, because two of its three arms choose a title.
    const mine = await this.api.resumes.mine();
    if (mine.ok) this.otherTitles.set(mine.resumes.map((r) => ({ id: r.id, title: r.title || '' })));

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
        title: this.freeTitle(d.title || 'Uploaded resume'),
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
      this.importedSkills = [...d.skills];
      this.dirty.set(true);
      this.showToast(
        pending.simulated
          ? 'Prefilled from a simulated analysis (demo mode), review each step, then save.'
          : 'We filled this in from your uploaded resume, review each step before saving.',
      );
    } else {
      this.resume.update((r) => ({ ...r, title: this.freeTitle('My resume'), personal: { ...r.personal, fullName: user.name, email: user.email } }));
    }
    if (welcome) this.showToast('Account created. Let’s build your resume.');

    const pRes = await this.api.postings.open();
    const demandedMap: Record<string, number> = {};
    if (pRes.ok) {
      for (const p of pRes.postings) for (const s of p.skills) demandedMap[s] = (demandedMap[s] || 0) + 1;
    }
    this.demanded.set(demandedMap);
    /* ALPHABETICAL, deliberately. This used to sort by demand, and removing
       the printed count while keeping that order would have changed nothing:
       the most-asked-for skills would still have been first, merely no longer
       saying so. The order must carry no signal about what is worth claiming.
       `demanded` is still computed — the datalist and the "you already list
       every skill asked for" note read it — but nothing renders the number. */
    this.poolAll.set(Object.keys(demandedMap).sort((a, b) => a.localeCompare(b)));

    this.ready.set(true);

    this.tour.init(
      'builder',
      [
        { sel: '#rail', title: 'Seven steps, in order', text: 'Move with Next, or jump straight to any step. Steps 1–5 are the resume itself; “More sections” is optional extras. Nothing is scored until you save, and you can come back and edit forever.' },
        { sel: '#paper', title: 'It builds as you type', text: 'This is the actual document a recruiter reads. Change a field on the left and watch it appear here.' },
        { sel: '#s0 .field', title: 'Start with the basics', text: 'Name, contact, and two or three plain sentences about yourself. Skip adjectives like "hardworking". Say what you did instead.' },
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

  /** "Save draft and leave", from the unsaved-changes dialog. The same save
   *  as the Save draft button, minus rewriting this page's address: the
   *  router is already on its way somewhere else, and a second navigation
   *  started now would cancel the one the user asked for. */
  saveBeforeLeaving(): Promise<boolean> {
    return this.save(false, { keepUrl: true });
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
    const next = Math.max(0, Math.min(STEPS.length - 1, i));
    if (STEPS[next] === 'Skills') this.evidenceAsked.set(true);
    this.step.set(next);
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

  /* ---------- putting entries in order ----------

     A resume is read top down, and the guidance this site gives is "most
     recent first". Until now the builder could only add an entry at the end
     and remove one: if you remembered an earlier job after typing a later
     one, the only way to fix the order was to delete an entry and type it
     again. The order is part of the content, so it needs to be editable like
     the rest of it. */
  private reorder<T>(arr: T[] | undefined, i: number, delta: number): T[] {
    const list = [...(arr ?? [])];
    const j = i + delta;
    if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
    [list[i], list[j]] = [list[j], list[i]];
    return list;
  }
  moveEducation(i: number, d: number): void {
    this.resume.update((r) => ({ ...r, education: this.reorder(r.education, i, d) }));
    this.markDirty();
  }
  moveExperience(i: number, d: number): void {
    this.resume.update((r) => ({ ...r, experience: this.reorder(r.experience, i, d) }));
    this.markDirty();
  }
  moveCertification(i: number, d: number): void {
    this.resume.update((r) => ({ ...r, certifications: this.reorder(r.certifications, i, d) }));
    this.markDirty();
  }
  moveProject(i: number, d: number): void {
    this.resume.update((r) => ({ ...r, projects: this.reorder(r.projects, i, d) }));
    this.markDirty();
  }
  moveLanguage(i: number, d: number): void {
    this.resume.update((r) => ({ ...r, languages: this.reorder(r.languages, i, d) }));
    this.markDirty();
  }
  moveReference(i: number, d: number): void {
    this.resume.update((r) => ({ ...r, references: this.reorder(r.references, i, d) }));
    this.markDirty();
  }

  // ---------- education ----------
  /* A new entry claims NOTHING until the applicant says otherwise. It used
     to arrive pre-set to 'bachelor' — rank 4 of 5 — so clicking "+ Add
     education" and typing nothing awarded a bachelor's degree to a quarter
     of the score, with a green tick on the readiness checklist confirming
     it. 'none' is rank 0: an entry nobody has filled in cannot lift a score. */
  addEducation(): void {
    this.resume.update((r) => ({ ...r, education: [...r.education, { school: '', degree: '', level: 'none', year: '' } as Education] }));
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

  /* ---------- private links ----------
     Portfolio and certificate URLs that go to the RECRUITER and never onto
     the printed sheet. Kept off the document on purpose: a long URL is a line
     of noise in a layout every design keeps parser-safe, and a link is not
     something a parser can read anyway. The recruiter sees them beside the
     resume, where a person can click one. Nothing here is scored. */
  addLink(): void {
    this.resume.update((r) => ({ ...r, links: [...(r.links ?? []), { label: '', url: '' } as ResumeLink] }));
    this.markDirty();
  }
  updateLink(i: number, field: 'label' | 'url', v: string): void {
    this.resume.update((r) => ({ ...r, links: (r.links ?? []).map((l, idx) => (idx === i ? { ...l, [field]: v } : l)) }));
    this.markDirty();
  }
  removeLink(i: number): void {
    this.resume.update((r) => ({ ...r, links: (r.links ?? []).filter((_, idx) => idx !== i) }));
    this.markDirty();
  }
  moveLink(i: number, d: number): void {
    this.resume.update((r) => ({ ...r, links: this.reorder(r.links, i, d) }));
    this.markDirty();
  }

  /** Only http and https are stored, so a `javascript:` address cannot run in
   *  the recruiter's browser and a relative path cannot point back at this
   *  site. Flagged as it is typed rather than dropped silently on save. */
  linkBad(l: ResumeLink): boolean {
    const u = String(l.url ?? '').trim();
    return !!u && !/^https?:\/\/\S+$/i.test(u);
  }

  /* ---------- sections the applicant switches off ----------
     A hidden section is left off the printed sheet AND out of the score.
     Those move together on purpose: a recruiter has to be able to read the
     match percentage as a statement about the document in front of them, so
     a section they will never see must not be quietly earning marks. The
     contents stay stored, so switching one back on restores it untouched.

     Skills, education and experience are not on this list. They are the three
     components every opening scores, and a sheet without them is not a
     resume. */
  readonly hideableSections: { key: ResumeSection; label: string; note: string }[] = [
    { key: 'summary', label: 'Summary', note: 'The paragraph under your name' },
    { key: 'projects', label: 'Projects', note: 'Scored when an opening asks for projects' },
    { key: 'certifications', label: 'Certifications', note: 'Scored when an opening asks for certificates' },
    { key: 'languages', label: 'Languages', note: 'Scored when an opening asks for languages' },
    { key: 'references', label: 'References', note: 'Scored when an opening asks for references' },
    { key: 'links', label: 'Links for the recruiter', note: 'Never on the sheet either way' },
  ];

  isHidden(k: ResumeSection): boolean { return (this.resume().hiddenSections ?? []).includes(k); }

  toggleSection(k: ResumeSection): void {
    this.resume.update((r) => {
      const cur = r.hiddenSections ?? [];
      const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      return { ...r, hiddenSections: next };
    });
    this.markDirty();
  }

  /** What a switched-off section actually holds, so the warning can say "3
   *  projects" rather than leaving the applicant to guess what they hid. */
  sectionCount(k: ResumeSection): number {
    const r = this.resume();
    switch (k) {
      case 'summary': return r.personal?.summary?.trim() ? 1 : 0;
      case 'projects': return (r.projects ?? []).length;
      case 'certifications': return (r.certifications ?? []).length;
      case 'languages': return (r.languages ?? []).length;
      case 'references': return (r.references ?? []).length;
      case 'links': return (r.links ?? []).length;
    }
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
    this.resume.update((r) => {
      const gone = r.skills[i];
      const ev = { ...(r.skillEvidence ?? {}) };
      delete ev[gone]; // a source for a skill that is no longer claimed is noise
      return { ...r, skills: r.skills.filter((_, idx) => idx !== i), skillEvidence: ev };
    });
    this.markDirty();
  }

  /* ---------- WHERE EACH SKILL WAS USED ----------
     The applicant picks a source from what they have ALREADY written on this
     resume — a job, a project, a certification, a course. It is a picker and
     never a text box, which is the entire point: a source that could be typed
     freely could be invented in the same breath as the skill it justifies.

     None of this reaches the printed sheet. The preview to the right and the
     downloaded document both render `skills` as a flat list, exactly as they
     did before; the source is read only by the recruiter's applicant view,
     and by the engine, which counts an unsourced skill at half. */

  /** Every source ON the resume as a flat list, each with the section label
   *  it belongs to. The Skills step renders one card per entry here and lets
   *  the applicant tick which skills they learned at it — the inverse of the
   *  old per-skill dropdown, and far fewer clicks when one place taught many
   *  skills. */
  evidenceSourceList = computed(() => {
    const labels = evidenceLabels(this.resume());
    const out: { kind: EvidenceKind; ref: string; kindLabel: string }[] = [];
    for (const kind of EVIDENCE_KINDS)
      for (const ref of labels[kind]) out.push({ kind, ref, kindLabel: EVIDENCE_KIND_LABELS[kind] });
    return out;
  });

  /** True when there is nothing on the resume to point at yet, so the step can
   *  say why there are no cards rather than showing an empty section. */
  noEvidenceSources = computed(() => this.evidenceSourceList().length === 0);

  /** The sources a skill currently points at, tolerating the older single
   *  object shape. */
  private sourcesFor(skill: string): SkillEvidence[] {
    return evidenceSources(this.resume().skillEvidence?.[skill]);
  }

  /** Is this skill ticked under this particular source? */
  skillLinkedTo(skill: string, kind: EvidenceKind, ref: string): boolean {
    return this.sourcesFor(skill).some((s) => s.kind === kind && s.ref === ref);
  }

  /** Does the skill point at anything at all? Drives the "counts at half" hint
   *  and the quiet marker on an unlinked chip. */
  skillHasSource(skill: string): boolean {
    return this.sourcesFor(skill).length > 0;
  }

  /** Add or remove one source from a skill's list. A skill can be learned in
   *  several places, so this is a set toggle, not a single choice. Removing the
   *  last source drops the key so an empty list is never stored. */
  toggleSkillSource(skill: string, kind: EvidenceKind, ref: string): void {
    this.resume.update((r) => {
      const map = { ...(r.skillEvidence ?? {}) };
      const cur = evidenceSources(map[skill]);
      const has = cur.some((s) => s.kind === kind && s.ref === ref);
      const next = has ? cur.filter((s) => !(s.kind === kind && s.ref === ref)) : [...cur, { kind, ref }];
      if (next.length) map[skill] = next; else delete map[skill];
      return { ...r, skillEvidence: map };
    });
    this.markDirty();
  }

  /** How many claimed skills point at nothing. A plain count with the
   *  consequence spelled out — not a warning, because half credit is a rule,
   *  not an error. */
  unsourcedSkills = computed(() => this.resume().skills.filter((s) => !this.skillHasSource(s)).length);
  /** A suggestion chip is a toggle, so the chip that added a skill by mistake
   *  is the one that takes it off again — in place, without hunting for it
   *  in the list above. */
  toggleSkill(s: string): void {
    const i = this.resume().skills.findIndex((x) => x.toLowerCase() === s.toLowerCase());
    if (i >= 0) this.removeSkill(i);
    else this.addSkill(s);
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
    { id: 'modern', label: 'Modern', note: 'Sans, navy accent', suits: 'Marketing, admin, client-facing roles' },
    { id: 'minimal', label: 'Minimal', note: 'Airy, light', suits: 'Design, media, start-ups' },
    { id: 'executive', label: 'Executive', note: 'Serif, formal', suits: 'Supervisory and management roles' },
    { id: 'banner', label: 'Banner', note: 'Dark header band', suits: 'Sales, events, customer-facing roles' },
    { id: 'split', label: 'Split', note: 'Name / contact split', suits: 'Administration, coordination' },
    { id: 'bar', label: 'Bar', note: 'Filled headings', suits: 'Retail, operations, logistics' },
    { id: 'rail', label: 'Rail', note: 'Left accent rail', suits: 'Any role wanting a little colour' },
    // The six added to the ATS set. Names differ from the brief's so they
    // don't collide with the eight above ("Classic" and "Executive" were
    // already taken by a different look).
    { id: 'traditional', label: 'Traditional', note: 'Georgia, thin rules', suits: 'The most conservative employers' },
    { id: 'clean', label: 'Clean', note: 'No rules, whitespace only', suits: 'Corporate roles, modern HR teams' },
    { id: 'compact', label: 'Compact', note: 'Tight, fits more on a page', suits: 'Long histories that must stay on one page' },
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
    this.showToast('File attached. Recruiters will see it, the engine won’t.');
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
  async save(andLeave: boolean, opts: { keepUrl?: boolean } = {}): Promise<boolean> {
    if (this.saving()) return false;
    this.formError.set(null);

    let r = this.resume();
    /* A NAME IS REQUIRED. It used to fall back to "Untitled resume", which is
       how an applicant ended up with several resumes nobody could tell apart
       in the picker. The builder pre-fills a free name, so this only stops
       someone who cleared it. */
    if (this.titleMissing()) {
      this.formError.set('Give this resume a name, so you can tell it apart when you apply. A recruiter sees the name too.');
      this.goTo(0);
      return false;
    }
    const contact = this.emailErr() ?? this.phoneErr() ?? this.linkedinErr();
    if (contact) {
      this.formError.set(contact);
      this.goTo(0);
      return false;
    }

    if (this.atResumeLimit()) {
      this.formError.set(`You already have ${MAX_RESUMES} resumes, the most one account can keep. Delete one you no longer use to make room for this one.`);
      return false;
    }

    /* TITLES MUST BE UNIQUE PER APPLICANT. The title is the only thing that
       tells two of your resumes apart — on the dashboard, in the picker when
       you apply, and against the application a recruiter receives. Two called
       the same thing means choosing blind, and a wrong choice is invisible
       afterwards.

       routes/resumes.ts is where this binds; this copy exists so the applicant
       lands on the field instead of reading an error after a round trip. */
    if (this.titleClash()) {
      this.formError.set(`You already have a resume called “${r.title.trim()}”. Give this one a different title — it is how you tell them apart when you apply.`);
      this.goTo(0);
      return false;
    }
    if (!r.personal.fullName.trim()) {
      this.formError.set('Add your name before saving, it’s the first line of the resume.');
      this.goTo(0);
      return false;
    }

    /* EDUCATION AND SKILLS CANNOT BE SKIPPED. They are two of the three
       components every opening scores, so a resume saved without them reaches
       a recruiter looking complete while carrying nothing for two thirds of
       the weighting — and the applicant is never told, because from their side
       nothing failed.

       Checked against CONTENT rather than the existence of a row: opening the
       education step and typing nothing leaves an entry object behind, and
       counting it would let the rule be satisfied by a row nobody filled in.

       The same rule is enforced in routes/resumes.ts, which is where it
       actually binds. This copy exists so the applicant lands on the step
       that needs them instead of reading an error after a round trip. */
    const hasEducation = (r.education || []).some(
      (e) => (e.school || '').trim() !== '' || (e.degree || '').trim() !== '');
    if (!hasEducation) {
      this.formError.set('Add at least one education entry before saving. Openings score education, so a resume without it cannot be matched fairly.');
      this.goTo(STEPS.indexOf('Education'));
      return false;
    }

    const hasSkills = (r.skills || []).some((s) => String(s || '').trim() !== '');
    if (!hasSkills) {
      this.formError.set('Add at least one skill before saving. Skills carry the largest share of every match score.');
      this.goTo(STEPS.indexOf('Skills'));
      return false;
    }

    /* Emitted only once the question has been put. An empty map is not the
       same as no map: empty means asked and no sources given, which is half
       credit; absent means never asked, which is full. */
    if (this.evidenceAsked() && !r.skillEvidence) {
      r = { ...r, skillEvidence: {} };
      // Into the form as well, not just the payload. The after-save check
      // below compares the form with what was sent, and a difference only the
      // save itself introduced read as unsaved typing: the form stayed dirty,
      // and finishing a resume asked "leave without saving?" on the way out.
      this.resume.set(r);
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
    if (!opts.keepUrl) {
      this.router.navigate([], { relativeTo: this.route, queryParams: { id: res.resume.id }, replaceUrl: true });
    }

    // Upload & Analyze flow: attach the original uploaded file to the saved
    // resume as the recruiter-visible copy (dual-resume model). One attempt —
    // if it fails, the user can attach it manually on the Finish step.
    if (this.pendingAnalysisFile && !this.resume().ownFile) {
      const file = this.pendingAnalysisFile;
      this.pendingAnalysisFile = null;
      const up = await this.api.resumes.uploadFile(res.resume.id!, file);
      if (up.ok) {
        this.resume.update((cur) => ({ ...cur, ownFile: up.ownFile }));
        await this.creditImportedSkillsToFile(up.ownFile?.name ?? '');
        this.showToast('Saved. And your original file is attached for recruiters to read.');
      }
    }

    if (andLeave) {
      /* A NEW RESUME BECOMES THE ACTIVE ONE once it is finished — the one just
         built is the one the applicant expects the board to score. Only on
         Finish, never on "Save draft": a half-built draft taking over the
         scoring would drop every match on the board. If this fails, the
         resume is still saved; the applicant can make it active by hand. */
      if (this.createdHere && this.resume().id) {
        const act = await this.api.resumes.setActive(this.resume().id!);
        if (act.ok) this.createdHere = false;
      }
      this.showToast('Resume saved. Scoring it now…');
      setTimeout(() => this.router.navigateByUrl('/seeker-dashboard'), 700);
    } else {
      this.showToast('Draft saved.');
    }
    return true;
  }

  /* THE UPLOADED FILE AS A SOURCE.

     A resume built here and a resume uploaded here are asked the same
     question — where was this skill used? — but only the built one could
     answer it, because the picker only offers entries the applicant typed.
     An imported CV therefore looked like an applicant who had been asked
     about every skill and declined every time, and lost half the credit on
     each one for the crime of arriving as a PDF.

     The file itself closes that gap honestly. It is not a free-text excuse:
     it is a document the recruiter can open and read, and the skill was read
     out of it by the analyzer rather than asserted here. So the skills the
     analyzer found are credited to the file, once, at the moment it is
     attached. Anything typed by hand afterwards is not, and a source the
     applicant chose for themselves is never overwritten.

     The second save is what makes it stick. On the first save the file is not
     attached yet, so the server would reject a source pointing at a file it
     has no record of — the same rule that rejects a source pointing at a job
     that was deleted. */
  private async creditImportedSkillsToFile(fileName: string): Promise<void> {
    const ref = fileName.trim();
    if (!ref || !this.importedSkills.length) return;

    /* ONLY WHEN THE QUESTION WAS PUT. An applicant who never reached the Skills
       step has no evidence map at all, and the engine reads that as "never
       asked" and credits every matched skill in full. Writing a map here would
       answer a question they were never shown — and it can only cost them,
       because any skill the analyzer's list does not match then counts at half.
       Measured on a four-skill opening where the applicant corrected one
       skill's spelling in the builder: 100 before, 94 after. The feature exists
       to stop an imported CV scoring below a typed one, so it must not be the
       thing that does it.

       And it does not come back. resumes.evidence_prompted is written with
       GREATEST, so once a map exists the resume can never be "never asked"
       again — which makes this the kind of mistake that is not recoverable by
       editing, and worth a guard rather than a note. */
    if (!this.evidenceAsked()) { this.importedSkills = []; return; }

    const fromFile = new Set(this.importedSkills.map((s) => s.toLowerCase()));
    this.importedSkills = [];

    let credited = false;
    this.resume.update((cur) => {
      const ev = { ...(cur.skillEvidence ?? {}) };
      for (const skill of cur.skills) {
        if (ev[skill] || !fromFile.has(skill.toLowerCase())) continue;
        ev[skill] = [{ kind: 'document', ref }];
        credited = true;
      }
      return credited ? { ...cur, skillEvidence: ev } : cur;
    });
    if (!credited) return;

    // Best effort. If it fails the resume is still saved and still correct,
    // it just scores as it did before, and the applicant can point the
    // skills at the file by hand from the picker, where it now appears.
    const res = await this.api.resumes.save(this.resume());
    if (res.ok) this.resume.update((cur) => ({ ...cur, ownFile: res.resume.ownFile }));
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
    return this.visibleLanguages().map((l) => this.joinMeta([l.name, l.proficiency], ', ')).join('  ·  ');
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
    /* The exported file is the VISIBLE resume, the same object the print
       sheet and the recruiter get. A switched-off section that survived into
       the plain-text copy would be the one route by which the applicant's own
       decision leaked back out, and the private links are kept off every
       document by construction. */
    const r = visibleResume(this.resume());
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
      L.push('LANGUAGES', r.languages.map((l) => [l.name, l.proficiency].filter(Boolean).join(', ')).join(', '), '');
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
      .map((e) => `<div class="p-item"><b>${esc([e.degree || 'Degree', e.field].filter(Boolean).join(', '))}</b>`
        + `<i>${meta([e.school, e.location, e.year])}</i>${e.honors ? `<p>${esc(e.honors)}</p>` : ''}</div>`)
      .join('');
    // Jobs still held first — the order every screen prints them in.
    const expHtml = experienceInPrintOrder(this.visibleExperience())
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
      ? `<p>${esc(this.visibleLanguages().map((l) => [l.name, l.proficiency].filter(Boolean).join(', ')).join(' · '))}</p>` : '';
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
    const summary = this.visibleSummary() ? `<div class="p-sec"><h2>Professional Summary</h2><p style="font-size:11.5px">${esc(this.visibleSummary())}</p></div>` : '';
    const ownFileNote = r.ownFile
      ? `<div class="p-sec"><h2>Attached by the applicant</h2><p style="font-size:11px;color:#5A5F6B">${esc(r.ownFile.name)}, sent to the recruiter alongside this resume. The engine does not read it, it scores what is printed here.</p></div>`
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
