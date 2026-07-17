import 'express-session';

declare module 'express-session' {
  interface SessionData {
    uid?: number;
  }
}

export interface UserRow {
  user_id: number;
  role: 'seeker' | 'recruiter';
  full_name: string;
  email: string;
  password_hash: string;
  active_resume_id: number | null;
  company_id: number | null;
  position_title: string | null;
  verified: number;
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
  status: 'open' | 'closed';
  created_at: string;
}

export interface ApplicationRow {
  application_id: number;
  seeker_id: number;
  resume_id: number;
  posting_id: number;
  status: 'submitted' | 'review' | 'shortlisted' | 'rejected' | 'hired';
  score_snapshot: number | null;
  applied_at: string;
  updated_at: string;
}
