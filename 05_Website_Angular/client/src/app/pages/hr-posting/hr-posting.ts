import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { EduLevel, EmploymentType, Posting, Resume } from '../../core/models';
import { EDU_LABELS, THRESHOLDS, WEIGHTS, scoreLocal, tierColor } from '../../core/engine';
import { reportInvalidFields } from '../../shared/invalid-fields';

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
  imports: [FormsModule, RouterLink, Header, Footer],
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
  monthsVal = signal(0);
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
  /* Certifications start at nothing, which is the whole design: the site-wide
     split is across three, and this component exists only for the recruiter
     who deliberately wants it. */
  wCert = signal(0);
  certsVal = signal<string[]>([]);
  certInput = signal('');

  /** The four as the engine will read them, or null when inheriting. */
  weightPayload = computed(() => (this.customWeights()
    ? { skills: this.wSkills(), education: this.wEdu(), experience: this.wExp(), certifications: this.wCert() }
    : null));

  weightTotal = computed(() => this.wSkills() + this.wEdu() + this.wExp() + this.wCert());
  /* The floor is policy, not arithmetic: a recruiter may decide a criterion
     matters less for a role, but switching one off entirely would score an
     applicant whose only strength is that criterion on a scale that cannot
     see them. Mirrored in routes/postings.ts and as a CHECK on the table. */
  readonly WEIGHT_FLOOR = 10;
  /* Certifications are exempt from the floor, and only certifications. The
     other three describe every applicant; a certificate is a thing many
     perfectly good candidates simply do not hold, so a recruiter has to be
     able to leave it at nothing — and nothing is where it starts. */
  weightsBelowFloor = computed(() =>
    this.wSkills() < this.WEIGHT_FLOOR || this.wEdu() < this.WEIGHT_FLOOR || this.wExp() < this.WEIGHT_FLOOR);
  weightsValid = computed(() => !this.customWeights()
    || (this.weightTotal() === 100 && !this.weightsBelowFloor()));
  weightError = computed(() => {
    if (!this.customWeights()) return null;
    if (this.weightsBelowFloor()) return `Skills, education and experience each have to be at least ${this.WEIGHT_FLOOR}%, those three cannot be switched off entirely.`;
    if (this.wCert() < 0) return 'The certifications share cannot be negative.';
    if (this.weightTotal() !== 100) return `The four have to add up to 100%. They add up to ${this.weightTotal()}%.`;
    return null;
  });
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
  knownSkills = computed(() => Array.from(new Set(this.posts().flatMap((p) => p.skills))).sort());
  /** Every skill this company already uses, shown whether or not it is on
   *  this opening. Dropping the chosen ones out of the pool reflowed the
   *  rows under the cursor mid-click; here that would put a skill the
   *  recruiter never meant to require onto the posting every applicant is
   *  then ranked against. */
  private requiredSkills = computed(() => new Set(this.skillsVal().map((s) => s.toLowerCase())));
  skillRequired = (s: string): boolean => this.requiredSkills().has(s.toLowerCase());
  poolSkills = computed(() => this.knownSkills());

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
      if (p.weights) {
        this.customWeights.set(true);
        this.wSkills.set(p.weights.skills);
        this.wEdu.set(p.weights.education);
        this.wExp.set(p.weights.experience);
        this.wCert.set(p.weights.certifications ?? 0);
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
  setType(e: Event): void { this.typeVal.set((e.target as HTMLSelectElement).value as EmploymentType); }
  setDesc(e: Event): void { this.descVal.set((e.target as HTMLTextAreaElement).value); }
  setEdu(e: Event): void { this.eduVal.set((e.target as HTMLSelectElement).value as EduLevel); }
  setMonths(e: Event): void { this.monthsVal.set(Number((e.target as HTMLInputElement).value) || 0); }
  setDeadline(e: Event): void { this.deadlineVal.set((e.target as HTMLInputElement).value); }
  setSkillInput(e: Event): void { this.skillInput.set((e.target as HTMLInputElement).value); }

  private pct(e: Event): number {
    const n = Math.round(Number((e.target as HTMLInputElement).value));
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  }
  setWSkills(e: Event): void { this.wSkills.set(this.pct(e)); }
  setWEdu(e: Event): void { this.wEdu.set(this.pct(e)); }
  setWExp(e: Event): void { this.wExp.set(this.pct(e)); }
  setWCert(e: Event): void { this.wCert.set(this.pct(e)); }

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
