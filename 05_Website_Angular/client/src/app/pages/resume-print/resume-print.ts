import { Location } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { Resume } from '../../core/models';

type SectionKind = 'education' | 'experience' | 'skills' | 'certifications';

/** Port of 04_Website/app/resume-print.html — an ATS-friendly, one-column
 *  print sheet. No site header/footer here, just a bespoke toolbar with
 *  Back / Print buttons; the printable "sheet" pulls a single resume by
 *  the ?id= query param and lays out its sections in the order implied
 *  by the resume's chosen template. */
@Component({
  selector: 'app-resume-print',
  standalone: true,
  imports: [],
  templateUrl: './resume-print.html',
  styleUrl: './resume-print.css',
})
export class ResumePrint implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private location = inject(Location);

  loading = signal(true);
  error = signal<string | null>(null);
  resume = signal<Resume | null>(null);

  contactLine = computed(() => {
    const p = this.resume()?.personal;
    if (!p) return '';
    return [p.email, p.phone, p.address].filter(Boolean).join('  ·  ');
  });

  sectionOrder = computed<SectionKind[]>(() => {
    const t = this.resume()?.template;
    if (t === 'functional') return ['skills', 'experience', 'education', 'certifications'];
    if (t === 'combination') return ['skills', 'education', 'experience', 'certifications'];
    return ['education', 'experience', 'skills', 'certifications'];
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.queryParamMap.get('id');
    if (!id) {
      this.error.set('No resume selected.');
      this.loading.set(false);
      return;
    }
    const res = await this.api.resumes.get(id);
    this.loading.set(false);
    if (!res.ok) {
      this.error.set(res.error);
      return;
    }
    this.resume.set(res.resume);
    document.title = `${res.resume.personal.fullName || 'Resume'} — ResumeMatch PH`;
  }

  monthsLabel(months: number): string {
    return months ? `${months} month${months > 1 ? 's' : ''}` : '';
  }

  back(): void {
    this.location.back();
  }

  print(): void {
    window.print();
  }
}
