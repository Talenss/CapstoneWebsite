import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { EduLevel, EmploymentType, Posting, Resume } from '../../core/models';
import { EDU_LABELS, SKILL_BY_INDUSTRY, SKILL_CATALOGUE, THRESHOLDS, WEIGHTS, WEIGHT_FLOOR, WEIGHT_STEP, scoreLocal, tierColor } from '../../core/engine';
import { reportInvalidFields } from '../../shared/invalid-fields';
import { HlmComboboxImports } from '@spartan-ng/helm/combobox';
import { HlmDatePickerImports } from '@spartan-ng/helm/date-picker';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { labelFor, SelectOption } from '../../shared/select-options';

/** Port of the PHP hr-posting.html — create/edit an opening. The
 *  required-skills / education / experience fields ARE the scoring rule,
 *  so the sidebar runs a live client-side simulation (scoreLocal) against
 *  every resume already in this recruiter's applicant pipeline as the
 *  recruiter edits the form. */
@Component({
  selector: 'app-hr-posting',
  standalone: true,
  // FormsModule is what makes (ngSubmit) an event that exists. Without it
  // Angular binds a listener for a custom DOM event named "ngSubmit" that
  // nothing ever dispatches — the template compiles, the button looks
  // right, and the browser performs a NATIVE submit instead: a GET to
  // /hr-posting? that reloads the page and throws the form away.
  imports: [FormsModule, RouterLink, Header, Footer, ...HlmComboboxImports, ...HlmDatePickerImports, ...HlmSelectImports],
  templateUrl: './hr-posting.html',
  styleUrl: './hr-posting.css',
})
export class HrPosting {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly eduKeys = Object.keys(EDU_LABELS) as EduLevel[];
  readonly eduLabels = EDU_LABELS;
  readonly weights = WEIGHTS;
  readonly thresholds = THRESHOLDS;
  readonly tierColor = tierColor;

  postingId = signal<string | null>(null);
  postingStatus = signal<'open' | 'closed'>('open');

  titleVal = signal('');
  deptVal = signal('');
  typeVal = signal<EmploymentType>('full-time');
  descVal = signal('');
  skillsVal = signal<string[]>([]);
  eduVal = signal<EduLevel>('bachelor');
  monthsVal = signal(0); // canonical unit — the engine and API speak months
  /** The recruiter enters YEARS (partner states requirements in years); the
   *  field shows this and stores months underneath. Whole and half years are
   *  the norm, so 24 months reads as 2 and 6 months as 0.5. */
  yearsVal = computed(() => { const m = this.monthsVal(); return m ? +(m / 12).toFixed(2) : 0; });
  deadlineVal = signal(''); // optional YYYY-MM-DD; empty = no deadline
  skillInput = signal('');

  /* Per-opening scoring weights, as whole percentages.
     customWeights false means this opening inherits the site defaults, and
     saves null rather than a copy of them — so if the study retunes its
     published weights, every opening that never customised follows along. */
  customWeights = signal(false);
  wSkills = signal(Math.round(WEIGHTS.skills * 100));
  wEdu = signal(Math.round(WEIGHTS.education * 100));
  wExp = signal(Math.round(WEIGHTS.experience * 100));
  /* THE FOUR OPTIONAL COMPONENTS all start at nothing, which is the whole
     design: the study's default split is 50/25/25 across three, and these
     exist only for the recruiter who deliberately wants one of them. An
     opening that never touches them scores exactly as it did before they
     were added. */
  wCert = signal(0);
  wProj = signal(0);
  wLang = signal(0);
  wRef = signal(0);
  wRelv = signal(0);
  certsVal = signal<string[]>([]);
  certInput = signal('');
  langsVal = signal<string[]>([]);
  langInput = signal('');
  /* Projects and references are scored the way experience is — a count
     against a stated minimum — so each needs its requirement as well as its
     share. 0 means "no minimum", which scores full marks. */
  minProjects = signal(0);
  minReferences = signal(0);

  /** All seven as the engine will read them, or null when inheriting. */
  weightPayload = computed(() => (this.customWeights()
    ? {
        skills: this.wSkills(), education: this.wEdu(), experience: this.wExp(),
        certifications: this.wCert(), projects: this.wProj(),
        languages: this.wLang(), references: this.wRef(),
        relevance: this.wRelv(),
      }
    : null));

  weightTotal = computed(() =>
    this.wSkills() + this.wEdu() + this.wExp()
    + this.wCert() + this.wProj() + this.wLang() + this.wRef() + this.wRelv());

  /* The floor is policy, not arithmetic: a recruiter may decide a criterion
     matters less for a role, but switching one off entirely would score an
     applicant whose only strength is that criterion on a scale that cannot
     see them. Mirrored in routes/postings.ts and as a CHECK on the table. */
  readonly WEIGHT_FLOOR = WEIGHT_FLOOR;
  /* Whole steps of 5. A weight is a judgement about what a role is worth,
     not a measurement, and 5-point steps say that honestly — 37% skills
     implies a precision no recruiter has. It also keeps the four optional
     components arithmetically able to reach 100 alongside the three floors. */
  readonly WEIGHT_STEP = WEIGHT_STEP;

  /* The three core components are exempt from nothing; the four optional
     ones are exempt from the floor. Skills, education and experience
     describe every applicant. A certificate, a portfolio of projects, a
     second language and a contactable referee are things plenty of perfectly
     good candidates do not have, so a recruiter has to be able to leave each
     at nothing — and nothing is where they all start. */
  weightsBelowFloor = computed(() =>
    this.wSkills() < this.WEIGHT_FLOOR || this.wEdu() < this.WEIGHT_FLOOR || this.wExp() < this.WEIGHT_FLOOR);
  private offStep = computed(() =>
    [this.wSkills(), this.wEdu(), this.wExp(), this.wCert(), this.wProj(), this.wLang(), this.wRef(), this.wRelv()]
      .some((v) => v % this.WEIGHT_STEP !== 0));
  weightsValid = computed(() => !this.customWeights()
    || (this.weightTotal() === 100 && !this.weightsBelowFloor() && !this.offStep()));
  weightError = computed(() => {
    if (!this.customWeights()) return null;
    if (this.weightsBelowFloor()) return `Skills, education and experience each have to be at least ${this.WEIGHT_FLOOR}%, those three cannot be switched off entirely.`;
    if (this.offStep()) return `Each share moves in steps of ${this.WEIGHT_STEP}%.`;
    if (this.weightTotal() !== 100) return `The shares have to add up to 100%. They add up to ${this.weightTotal()}%.`;
    return null;
  });

  /* The optional four, driven from one list so the form draws four identical
     rows instead of four near-identical copies that can drift apart. */
  readonly optionalWeightRows = [
    { key: 'certifications', label: 'Certifications', value: this.wCert, set: (n: number) => this.wCert.set(n) },
    { key: 'projects', label: 'Projects', value: this.wProj, set: (n: number) => this.wProj.set(n) },
    { key: 'languages', label: 'Languages', value: this.wLang, set: (n: number) => this.wLang.set(n) },
    { key: 'references', label: 'References', value: this.wRef, set: (n: number) => this.wRef.set(n) },
    /* Relevant experience reads the job's OWN words. It sits with the optional
       components rather than beside "Experience" because it is a second,
       stricter reading of the same months, not a replacement for them: leave
       it at zero and the opening scores exactly as it did before the
       component existed. */
    { key: 'relevance', label: 'Relevant experience', value: this.wRelv, set: (n: number) => this.wRelv.set(n) },
  ] as const;

  /* THE RECRUITER'S OWN SCREENING QUESTIONS.
     Free text, because only the recruiter knows what this opening actually
     needs to ask. Nothing here is scored and nothing is matched: the answers
     are shown beside the applicant for a person to read. Every question is
     mandatory — an applicant cannot submit until all of them are answered —
     which is why the count is capped and each one is short enough to be read
     at a glance on the apply screen. */
  readonly MAX_QUESTIONS = 10;
  questionsVal = signal<string[]>([]);
  questionInput = signal('');
  todayStr = new Date().toISOString().slice(0, 10);

  titleInvalid = signal(false);
  deptInvalid = signal(false);
  descInvalid = signal(false);
  skillsInvalid = signal(false);

  msg = signal<string | null>(null);
  saving = signal(false);
  toastMsg = signal<string | null>(null);

  posts = signal<Posting[]>([]);
  knownResumes = signal<{ resume: Resume; name: string }[]>([]);

  deptOptions = computed(() => Array.from(new Set(this.posts().map((p) => p.department).filter(Boolean))).sort());
  /* The datalist offers the whole catalogue as well as what this company has
     already used, so a recruiter can type "pay" and be offered Payroll
     Processing rather than having to remember the exact wording. Matching is
     on the canonical form, so an entry from either source scores the same. */
  knownSkills = computed(() => Array.from(new Set([
    ...this.posts().flatMap((p) => p.skills),
    ...SKILL_CATALOGUE.map((s) => s.name),
  ])).sort((a, b) => a.localeCompare(b)));

  /** What this company has used before, which is empty for a first opening. */
  usedSkills = computed(() => Array.from(new Set(this.posts().flatMap((p) => p.skills))).sort());

  /** The catalogue, grouped, minus anything already offered by usedSkills so
   *  the same chip is never in two pools at once. */
  readonly catalogueByIndustry = SKILL_BY_INDUSTRY;
  industryOpen = signal<string | null>(null);
  toggleIndustry(name: string): void {
    this.industryOpen.set(this.industryOpen() === name ? null : name);
  }
  /** Every skill this company already uses, shown whether or not it is on
   *  this opening. Dropping the chosen ones out of the pool reflowed the
   *  rows under the cursor mid-click; here that would put a skill the
   *  recruiter never meant to require onto the posting every applicant is
   *  then ranked against. */
  private requiredSkills = computed(() => new Set(this.skillsVal().map((s) => s.toLowerCase())));
  skillRequired = (s: string): boolean => this.requiredSkills().has(s.toLowerCase());
  poolSkills = computed(() => this.usedSkills());

  simRows = computed(() => {
    const skills = this.skillsVal();
    const known = this.knownResumes();
    if (!skills.length || !known.length) return [];
    /* The simulation has to score with the weights CURRENTLY in the form,
       not the site defaults — otherwise dragging a weight changes nothing on
       screen and the recruiter cannot see what the change does to the very
       ranking they are tuning. */
    const posting = {
      skills, educationLevel: this.eduVal(), minExperienceMonths: this.monthsVal(),
      certifications: this.certsVal(),
      languages: this.langsVal(),
      minProjects: this.minProjects(), minReferences: this.minReferences(),
      weights: this.weightsValid() ? this.weightPayload() : null,
    };
    return known
      .map((k) => ({ name: k.name, ...scoreLocal(k.resume, posting) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  });

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.init(params.get('id'));
    });

    // Take the pick, then hand the control back its empty state so the next
    // search starts clean. Setting skillPick to null re-enters this effect
    // once and stops at the guard.
    //
    // The clear is deferred by a task on purpose. The combobox writes its own
    // value synchronously when an item is chosen, and this effect runs inside
    // the same change-detection pass, so clearing here is immediately
    // overwritten and the trigger keeps showing the last pick. Anything that
    // lands in a later task works; a plain setTimeout is the least machinery.
    effect(() => {
      const picked = this.skillPick();
      if (!picked) return;
      this.addSkill(picked);
      setTimeout(() => this.skillPick.set(null));
    });
  }

  private async init(id: string | null): Promise<void> {
    this.postingId.set(id);

    const mineRes = await this.api.postings.mine();
    const posts = mineRes.ok ? mineRes.postings : [];
    this.posts.set(posts);

    if (id) {
      const res = await this.api.postings.get(id);
      if (!res.ok) { this.router.navigateByUrl('/hr-dashboard'); return; }
      const p = res.posting;
      this.postingStatus.set(p.status);
      this.titleVal.set(p.title);
      this.deptVal.set(p.department);
      this.typeVal.set(p.employmentType || 'full-time');
      this.descVal.set(p.description);
      this.skillsVal.set([...p.skills]);
      this.eduVal.set(p.educationLevel);
      this.monthsVal.set(p.minExperienceMonths || 0);
      this.deadlineVal.set(p.deadline || '');
      this.certsVal.set([...(p.certifications ?? [])]);
      this.langsVal.set([...(p.languages ?? [])]);
      this.minProjects.set(p.minProjects ?? 0);
      this.minReferences.set(p.minReferences ?? 0);
      this.questionsVal.set((p.questions ?? []).map((q) => q.prompt));
      if (p.weights) {
        this.customWeights.set(true);
        this.wSkills.set(p.weights.skills);
        this.wEdu.set(p.weights.education);
        this.wExp.set(p.weights.experience);
        this.wCert.set(p.weights.certifications ?? 0);
        this.wProj.set(p.weights.projects ?? 0);
        this.wLang.set(p.weights.languages ?? 0);
        this.wRef.set(p.weights.references ?? 0);
        this.wRelv.set((p.weights as any).relevance ?? 0);
      }
    }

    // Recruiters can only see resumes actually submitted to their company, so
    // the simulator is fed by the applicants already in their pipeline.
    const known: { resume: Resume; name: string }[] = [];
    for (const p of posts) {
      const rk = await this.api.applications.ranked(p.id);
      if (!rk.ok) continue;
      for (const r of rk.rows) {
        if (!known.some((x) => x.resume.id === r.resume.id)) known.push({ resume: r.resume, name: r.seeker.name });
      }
    }
    this.knownResumes.set(known);
  }

  setTitle(e: Event): void { this.titleVal.set((e.target as HTMLInputElement).value); }
  setDept(e: Event): void { this.deptVal.set((e.target as HTMLInputElement).value); }
  readonly typeOptions: readonly SelectOption<EmploymentType>[] = [
    { v: 'full-time', label: 'Full time' },
    { v: 'part-time', label: 'Part time' },
    { v: 'contract', label: 'Contract' },
    { v: 'internship', label: 'Internship' },
  ];
  readonly typeLabel = labelFor(this.typeOptions);
  readonly eduLabel = (v: EduLevel): string => this.eduLabels[v] ?? String(v ?? '');
  setDesc(e: Event): void { this.descVal.set((e.target as HTMLTextAreaElement).value); }
  setYears(e: Event): void {
    const y = Number((e.target as HTMLInputElement).value) || 0;
    this.monthsVal.set(Math.max(0, Math.round(y * 12)));
  }
  /** The deadline is stored as the plain YYYY-MM-DD the API expects, while the
   *  picker works in Date objects. Both conversions go through local calendar
   *  parts rather than toISOString(), which would shift the day backwards for
   *  anyone east of UTC — Manila included, where a deadline set for the 10th
   *  would be saved as the 9th. */
  readonly deadlineDate = computed<Date | undefined>(() => {
    const [y, m, d] = this.deadlineVal().split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : undefined;
  });
  readonly todayDate = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  onDeadlineChange(d: Date | null): void {
    if (!d) { this.deadlineVal.set(''); return; }
    const p = (n: number) => String(n).padStart(2, '0');
    this.deadlineVal.set(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }

  clearDeadline(): void { this.deadlineVal.set(''); }

  /** The picker's own default is Date.toDateString, which reads "Wed Sep 23
   *  2026". Every other date on the site is en-PH short form, so this one is
   *  too. Declared as a field, not a method, because it is passed as a value. */
  readonly formatPickedDate = (d: Date): string =>
    d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  setSkillInput(e: Event): void { this.skillInput.set((e.target as HTMLInputElement).value); }

  /* Snapped to the step here as well as in the input's own `step` attribute.
     The attribute governs the arrows and the slider; it does not stop a
     number being typed or pasted straight into the box, and a 37 that reached
     the payload would be refused by the server with an error the recruiter
     did not cause. Snapping as it is typed keeps the form and the rule the
     same rule. */
  private pct(e: Event): number {
    const n = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return 0;
    const snapped = Math.round(n / WEIGHT_STEP) * WEIGHT_STEP;
    return Math.min(100, Math.max(0, snapped));
  }
  setWSkills(e: Event): void { this.wSkills.set(this.pct(e)); }
  setWEdu(e: Event): void { this.wEdu.set(this.pct(e)); }
  setWExp(e: Event): void { this.wExp.set(this.pct(e)); }
  setWeight(set: (n: number) => void, e: Event): void { set(this.pct(e)); }

  private count(e: Event): number {
    const n = Math.round(Number((e.target as HTMLInputElement).value));
    return Number.isFinite(n) ? Math.min(50, Math.max(0, n)) : 0;
  }
  setMinProjects(e: Event): void { this.minProjects.set(this.count(e)); }
  setMinReferences(e: Event): void { this.minReferences.set(this.count(e)); }

  toggleCustomWeights(e: Event): void {
    const on = (e.target as HTMLInputElement).checked;
    this.customWeights.set(on);
    // Turning it on starts from the site defaults rather than whatever was
    // last typed, so the recruiter always adjusts from a known 100%.
    if (on) this.resetWeights();
  }

  resetWeights(): void {
    this.wSkills.set(Math.round(WEIGHTS.skills * 100));
    this.wEdu.set(Math.round(WEIGHTS.education * 100));
    this.wExp.set(Math.round(WEIGHTS.experience * 100));
    this.wCert.set(0);
    this.wProj.set(0);
    this.wLang.set(0);
    this.wRef.set(0);
    this.wRelv.set(0);
  }

  /** Every skill the catalogue knows, for the combobox to search. The pool
   *  chips below still show what this company already uses; this is the way
   *  in to the rest of the catalogue without typing it exactly right. */
  readonly allCatalogueSkills = SKILL_CATALOGUE.map((s) => s.name).sort((a, b) => a.localeCompare(b));

  /** The combobox is a picker, not a field: taking a value adds the skill and
   *  clears itself, so it behaves like the chips rather than holding state
   *  that could disagree with the list underneath. */
  /** Two-way bound to the combobox, so the control's own value comes back
   *  here and can be cleared again after the pick has been taken.
   *
   *  This control ADDS a skill to the list below; it does not hold one. Left
   *  set, the trigger keeps showing the last pick as though the posting
   *  required only that, and the placeholder inviting another search never
   *  returns. The binding has to be two-way for the clear to land: the
   *  combobox's value is a model(), so writing null to a signal that is
   *  already null is not a change and Angular never pushes it back down. */
  readonly skillPick = signal<string | null>(null);

  // read: ElementRef matters — the ref sits on a component, so without it
  // viewChild hands back the component instance, which has no nativeElement.
  private skillTrigger = viewChild('skillTrigger', { read: ElementRef });

  /** The catalogue panel is 288px tall, and the popover flips to sit ABOVE the
   *  trigger when that will not fit below it. That is ordinary behaviour and
   *  right in most places, but on this form the space above the field is the
   *  "The scoring rule" heading and the field's own label, so a flip hides the
   *  very thing being filled in.
   *
   *  The popover's scroll strategy is "reposition", so it re-evaluates its
   *  position as the page scrolls: making room below the trigger is enough to
   *  bring the panel back down, without overriding the library's positioning. */
  onComboState(state: 'open' | 'closed'): void {
    if (state !== 'open') return;
    const el = this.skillTrigger()?.nativeElement as HTMLElement | undefined;
    if (!el) return;
    const NEEDED = 294;                       // 288px panel + the 6px offset
    const below = window.innerHeight - el.getBoundingClientRect().bottom;
    if (below >= NEEDED) return;
    window.scrollBy({
      top: NEEDED - below,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }

  onSkillKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addSkill(this.skillInput()); }
  }

  addSkill(raw: string): void {
    const s = String(raw).trim();
    if (!s) return;
    if (this.skillsVal().some((x) => x.toLowerCase() === s.toLowerCase())) { this.showToast('Already required.'); return; }
    this.skillsVal.update((arr) => [...arr, s]);
    this.skillInput.set('');
    this.skillsInvalid.set(false);
  }

  removeSkill(i: number): void {
    this.skillsVal.update((arr) => arr.filter((_, idx) => idx !== i));
  }

  onCertKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addCert(this.certInput()); }
  }

  /** Free text, unlike skills — a certificate is called whatever the body
   *  issuing it calls it, and there is no catalogue to pick from. */
  addCert(raw: string): void {
    const c = String(raw).trim().slice(0, 160);
    if (!c) return;
    if (this.certsVal().some((x) => x.toLowerCase() === c.toLowerCase())) { this.showToast('Already required.'); return; }
    this.certsVal.update((arr) => [...arr, c]);
    this.certInput.set('');
  }

  removeCert(i: number): void {
    this.certsVal.update((arr) => arr.filter((_, idx) => idx !== i));
  }

  onLangKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addLang(this.langInput()); }
  }

  /** Free text, like certificates. Matched by name, so "Filipino" on the
   *  opening and "Filipino" on the resume are the same requirement while
   *  "Tagalog" is not — which is why the recruiter names the language the
   *  way they expect to see it written. */
  addLang(raw: string): void {
    const l = String(raw).trim().slice(0, 80);
    if (!l) return;
    if (this.langsVal().some((x) => x.toLowerCase() === l.toLowerCase())) { this.showToast('Already required.'); return; }
    this.langsVal.update((arr) => [...arr, l]);
    this.langInput.set('');
  }

  removeLang(i: number): void {
    this.langsVal.update((arr) => arr.filter((_, idx) => idx !== i));
  }

  onQuestionKeydown(e: KeyboardEvent): void {
    // Enter only. A comma is ordinary punctuation inside a question, where it
    // is a separator in a list of skills or certificates.
    if (e.key === 'Enter') { e.preventDefault(); this.addQuestion(this.questionInput()); }
  }

  addQuestion(raw: string): void {
    const q = String(raw).trim().slice(0, 300);
    if (!q) return;
    if (this.questionsVal().length >= this.MAX_QUESTIONS) {
      this.showToast(`${this.MAX_QUESTIONS} questions is the most an opening can ask.`);
      return;
    }
    if (this.questionsVal().some((x) => x.toLowerCase() === q.toLowerCase())) { this.showToast('Already asked.'); return; }
    this.questionsVal.update((arr) => [...arr, q]);
    this.questionInput.set('');
  }

  removeQuestion(i: number): void {
    this.questionsVal.update((arr) => arr.filter((_, idx) => idx !== i));
  }

  moveQuestion(i: number, by: number): void {
    const to = i + by;
    this.questionsVal.update((arr) => {
      if (to < 0 || to >= arr.length) return arr;
      const next = [...arr];
      [next[i], next[to]] = [next[to], next[i]];
      return next;
    });
  }

  /** The pool chips are toggles, so a chip clicked by mistake is undone by
   *  clicking the same chip again. */
  toggleSkill(s: string): void {
    const i = this.skillsVal().findIndex((x) => x.toLowerCase() === s.toLowerCase());
    if (i >= 0) this.removeSkill(i);
    else this.addSkill(s);
  }

  async submit(): Promise<void> {
    const title = this.titleVal().trim();
    const department = this.deptVal().trim();
    const description = this.descVal().trim();
    const skills = this.skillsVal();

    const titleOk = title.length >= 2;
    const deptOk = department.length >= 2;
    const descOk = description.length >= 10;
    const skillsOk = skills.length > 0;

    this.titleInvalid.set(!titleOk);
    this.deptInvalid.set(!deptOk);
    this.descInvalid.set(!descOk);
    this.skillsInvalid.set(!skillsOk);

    // The summary is announced (role="alert"), and the keyboard is put on
    // the first field that failed — scrolling the window to the top only
    // ever helped someone who could see where it landed.
    const allOk = reportInvalidFields([
      { id: 'title', invalid: !titleOk },
      { id: 'dept', invalid: !deptOk },
      { id: 'desc', invalid: !descOk },
      { id: 'skillInput', invalid: !skillsOk },
    ]);
    if (!allOk) {
      this.msg.set('Fill in the highlighted fields before publishing.');
      return;
    }
    if (!this.weightsValid()) {
      this.msg.set(this.weightError()!);
      return;
    }

    const payload: Partial<Posting> = {
      title, department, employmentType: this.typeVal(), description,
      skills, educationLevel: this.eduVal(),
      minExperienceMonths: Math.max(0, this.monthsVal() || 0),
      certifications: this.certsVal(),
      languages: this.langsVal(),
      minProjects: this.minProjects(),
      minReferences: this.minReferences(),
      questions: this.questionsVal().map((prompt) => ({ prompt })),
      deadline: this.deadlineVal() || null,
      status: this.postingStatus(),
      weights: this.weightPayload(),
    };
    const id = this.postingId();
    if (id) payload.id = id;

    this.saving.set(true);
    const res = await this.api.postings.save(payload);
    this.saving.set(false);

    if (!res.ok) { this.msg.set(res.error); return; }
    this.msg.set(null);
    this.showToast(id ? 'Opening updated.' : 'Opening published. Applicants can see it now.');
    setTimeout(() => this.router.navigateByUrl('/hr-dashboard'), 800);
  }

  private showToast(msg: string): void {
    this.toastMsg.set(msg);
    setTimeout(() => this.toastMsg.set(null), 3000);
  }
}
