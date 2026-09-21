import 'express-session';

declare module 'express-session' {
  interface SessionData {
    uid?: number;
  }
}

export interface UserRow {
  user_id: number;
  role: 'seeker' | 'recruiter' | 'admin';
  first_name: string;
  last_name: string;
  /** Derived in the database from first_name + last_name. Read-only:
   *  an INSERT or UPDATE naming this column is rejected by Postgres. */
  full_name: string;
  email: string;
  password_hash: string;
  active_resume_id: number | null;
  company_id: number | null;
  position_title: string | null;
  verified: number;
  email_notifications: number;
  created_at: string;
  last_login_at: string | null;
}

export interface CompanyRow {
  company_id: number;
  company_name: string;
  industry: string | null;
  location: string | null;
  about: string | null;
  website: string | null;
  created_at: string;
}

export interface ResumeRow {
  resume_id: number;
  user_id: number;
  title: string;
  template_type: 'chronological' | 'functional' | 'combination';
  design: 'classic' | 'modern' | 'minimal' | 'executive' | 'banner' | 'split' | 'bar' | 'rail'
    | 'traditional' | 'clean' | 'compact' | 'senior' | 'graduate' | 'technical';
  full_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  summary: string | null;
  own_file_name: string | null;
  own_file_mime: string | null;
  own_file_size: number | null;
  own_file_path: string | null;
  own_file_uploaded_at: string | null;
  /** The applicant's own document, read into the shape the builder edits, so
   *  the engine can score it. Null until a file is uploaded, or when the
   *  reading failed — own_file_extract_status says which. */
  own_file_extract: any | null;
  own_file_extract_status: 'ok' | 'unavailable' | 'unreadable' | 'failed' | null;
  own_file_extract_at: string | null;
  /** 1 once the applicant has been ASKED where each skill was used — which
   *  the builder does and an import from an uploaded CV does not. Gates
   *  whether serializeResume emits skillEvidence at all, and so whether a
   *  matched skill with no source is scored at half credit or in full. */
  evidence_prompted: number;
  /** Comma-separated section keys the applicant switched off, '' for none.
   *  A hidden section is left off the printed sheet and out of the score;
   *  see visibleResume() in lib/serializers. */
  hidden_sections: string;
  created_at: string;
  updated_at: string;
}

export interface PostingRow {
  posting_id: number;
  company_id: number;
  created_by: number | null;
  title: string;
  department: string | null;
  employment_type: 'full-time' | 'part-time' | 'contract' | 'internship';
  description: string | null;
  education_level: string;
  min_experience_months: number;
  application_deadline: string | null;
  status: 'open' | 'closed';
  created_at: string;
  /* Whole percentages. All three null together = inherit match_settings. */
  weight_skills: number | null;
  weight_education: number | null;
  weight_experience: number | null;
  /** The optional components. NULL means 0 — the opening does not score that
   *  section — which is what every opening written before each column existed
   *  carries, and why none of them needed rewriting. */
  weight_certifications: number | null;
  weight_projects: number | null;
  weight_languages: number | null;
  weight_references: number | null;
  weight_relevance: number | null;
  weight_field: number | null;
  /** Minimum counts for the two sections scored the way experience is. 0
   *  states no requirement, which scores full marks on that component. */
  min_projects: number;
  min_references: number;
}

export interface ApplicationRow {
  application_id: number;
  seeker_id: number;
  resume_id: number;
  posting_id: number;
  status: 'submitted' | 'scheduling' | 'initial_interview' | 'testing' | 'shortlisted'
    | 'final_interview' | 'offer' | 'hired' | 'rejected' | 'withdrawn' | 'review';
  score_snapshot: number | null;
  applied_at: string;
  updated_at: string;
}
