import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';
import { ApiService } from '../../core/api.service';
import { EduLevel, EmploymentType, Posting, Resume } from '../../core/models';
import { EDU_LABELS, THRESHOLDS, WEIGHTS, scoreLocal, tierColor } from '../../core/engine';

/** Port of 04_Website/app/hr-posting.html — create/edit an opening. The
 *  required-skills / education / experience fields ARE the scoring rule,
 *  so the sidebar runs a live client-side simulation (scoreLocal) against
 *  every resume already in this recruiter's applicant pipeline as the
 *  recruiter edits the form. */
@Component({
  selector: 'app-hr-posting',
  standalone: true,
  imports: [RouterLink, Header, Footer],
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
  poolSkills = computed(() => {
    const have = this.skillsVal().map((s) => s.toLowerCase());
    return this.knownSkills().filter((s) => !have.includes(s.toLowerCase()));
  });

  simRows = computed(() => {
    const skills = this.skillsVal();
    const known = this.knownResumes();
    if (!skills.length || !known.length) return [];
    const posting = { skills, educationLevel: this.eduVal(), minExperienceMonths: this.monthsVal() };
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

    if (!(titleOk && deptOk && descOk && skillsOk)) {
      this.msg.set('Fill in the highlighted fields before publishing.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const payload: Partial<Posting> = {
      title, department, employmentType: this.typeVal(), description,
      skills, educationLevel: this.eduVal(),
      minExperienceMonths: Math.max(0, this.monthsVal() || 0),
      deadline: this.deadlineVal() || null,
      status: this.postingStatus(),
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
