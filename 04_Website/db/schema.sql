-- ============================================================
-- ResumeMatch PH — MySQL schema
-- Target: MySQL 8.x / MariaDB 10.4+ (XAMPP)
--
-- Table names deliberately match Figure 5 (the ERD already in
-- the paper). New tables here are ADDITIVE — the existing ERD
-- stays correct; it just gains two boxes.
--
-- Matching weights (initial, refined iteratively per the paper):
--   skills 0.50 · education 0.25 · experience 0.25
--   strong match >= 80 · related-role fallback < 50
-- Statuses: submitted · review · shortlisted · rejected · hired
--
-- Run:  mysql -u root < db/schema.sql
-- ============================================================

DROP DATABASE IF EXISTS resumematch_ph;
CREATE DATABASE resumematch_ph CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE resumematch_ph;

-- ------------------------------------------------------------
-- Companies
-- ------------------------------------------------------------
CREATE TABLE companies (
  company_id    INT AUTO_INCREMENT PRIMARY KEY,
  company_name  VARCHAR(160) NOT NULL,
  industry      VARCHAR(120),
  location      VARCHAR(200),
  about         TEXT,
  website       VARCHAR(255),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Users.  One table, two roles.
-- Recruiter accounts are PROVISIONED (created by the research
-- team with the partner company's HR) — never self-registered.
-- ------------------------------------------------------------
CREATE TABLE users (
  user_id          INT AUTO_INCREMENT PRIMARY KEY,
  role             ENUM('seeker','recruiter') NOT NULL DEFAULT 'seeker',
  full_name        VARCHAR(120) NOT NULL,
  email            VARCHAR(160) NOT NULL UNIQUE,
  password_hash    VARCHAR(255) NOT NULL,          -- bcrypt via password_hash()
  active_resume_id INT NULL,                       -- FK added after `resumes` exists
  -- recruiter-only columns
  company_id       INT NULL,
  position_title   VARCHAR(120) NULL,
  verified         TINYINT(1) NOT NULL DEFAULT 0,  -- a recruiter cannot log in until this is 1
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login_at    DATETIME NULL,
  CONSTRAINT fk_user_company FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE SET NULL,
  INDEX idx_users_role (role)
) ENGINE=InnoDB;

-- Public "request recruiter access" submissions. Reviewed by hand.
CREATE TABLE recruiter_requests (
  request_id     INT AUTO_INCREMENT PRIMARY KEY,
  full_name      VARCHAR(120) NOT NULL,
  email          VARCHAR(160) NOT NULL,
  position_title VARCHAR(120),
  company_id     INT NULL,
  note           TEXT,
  status         ENUM('pending','approved','declined') NOT NULL DEFAULT 'pending',
  requested_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_req_company FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE SET NULL,
  INDEX idx_req_status (status)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Resumes.  The DUAL-RESUME MODEL lives here:
--   · the structured columns/children below are what gets SCORED
--   · own_file_* is the applicant's own document — shown to HR,
--     NEVER parsed and NEVER scored (see paper delimitations)
-- ------------------------------------------------------------
CREATE TABLE resumes (
  resume_id     INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  title         VARCHAR(120) NOT NULL,
  template_type ENUM('chronological','functional','combination') NOT NULL DEFAULT 'chronological',
  full_name     VARCHAR(120),
  email         VARCHAR(160),
  phone         VARCHAR(40),
  address       VARCHAR(200),
  summary       TEXT,
  own_file_name VARCHAR(200) NULL,
  own_file_mime VARCHAR(100) NULL,
  own_file_size INT NULL,
  own_file_path VARCHAR(255) NULL,                 -- relative to api/uploads/, never web-reachable
  own_file_uploaded_at DATETIME NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_resume_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  INDEX idx_resume_user (user_id)
) ENGINE=InnoDB;

ALTER TABLE users
  ADD CONSTRAINT fk_user_active_resume
  FOREIGN KEY (active_resume_id) REFERENCES resumes(resume_id) ON DELETE SET NULL;

CREATE TABLE education (
  education_id INT AUTO_INCREMENT PRIMARY KEY,
  resume_id    INT NOT NULL,
  school       VARCHAR(160),
  degree       VARCHAR(160),
  level        ENUM('none','highschool','vocational','associate','bachelor','master') NOT NULL DEFAULT 'bachelor',
  year_grad    VARCHAR(10),
  sort_order   INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_edu_resume FOREIGN KEY (resume_id) REFERENCES resumes(resume_id) ON DELETE CASCADE,
  INDEX idx_edu_resume (resume_id)
) ENGINE=InnoDB;

CREATE TABLE work_experience (
  experience_id INT AUTO_INCREMENT PRIMARY KEY,
  resume_id     INT NOT NULL,
  position      VARCHAR(160),
  company       VARCHAR(160),
  months        INT NOT NULL DEFAULT 0,
  description   TEXT,
  sort_order    INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_exp_resume FOREIGN KEY (resume_id) REFERENCES resumes(resume_id) ON DELETE CASCADE,
  INDEX idx_exp_resume (resume_id)
) ENGINE=InnoDB;

CREATE TABLE certifications (
  certification_id INT AUTO_INCREMENT PRIMARY KEY,
  resume_id        INT NOT NULL,
  cert_name        VARCHAR(200),
  year_taken       VARCHAR(10),
  sort_order       INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_cert_resume FOREIGN KEY (resume_id) REFERENCES resumes(resume_id) ON DELETE CASCADE,
  INDEX idx_cert_resume (resume_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Skills.  One canonical row per skill; resumes and postings
-- both point at it, so "MySQL" on a resume and "MySQL" on a
-- posting are literally the same row — that IS the match.
-- ------------------------------------------------------------
CREATE TABLE skills (
  skill_id   INT AUTO_INCREMENT PRIMARY KEY,
  skill_name VARCHAR(120) NOT NULL,
  skill_norm VARCHAR(120) NOT NULL UNIQUE,        -- lowercased, alphanumerics only
  category   ENUM('technical','soft') NOT NULL DEFAULT 'technical'
) ENGINE=InnoDB;

CREATE TABLE resume_skills (
  resume_id INT NOT NULL,
  skill_id  INT NOT NULL,
  PRIMARY KEY (resume_id, skill_id),
  CONSTRAINT fk_rs_resume FOREIGN KEY (resume_id) REFERENCES resumes(resume_id) ON DELETE CASCADE,
  CONSTRAINT fk_rs_skill  FOREIGN KEY (skill_id)  REFERENCES skills(skill_id)   ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Job postings
-- ------------------------------------------------------------
CREATE TABLE job_postings (
  posting_id      INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  created_by      INT NULL,
  title           VARCHAR(160) NOT NULL,
  department      VARCHAR(120),
  employment_type ENUM('full-time','part-time','contract','internship') NOT NULL DEFAULT 'full-time',
  description     TEXT,
  education_level ENUM('none','highschool','vocational','associate','bachelor','master') NOT NULL DEFAULT 'bachelor',
  min_experience_months INT NOT NULL DEFAULT 0,
  status          ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_post_company FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE,
  CONSTRAINT fk_post_author  FOREIGN KEY (created_by) REFERENCES users(user_id)        ON DELETE SET NULL,
  INDEX idx_post_status (status),
  INDEX idx_post_company (company_id)
) ENGINE=InnoDB;

CREATE TABLE posting_skills (
  posting_id INT NOT NULL,
  skill_id   INT NOT NULL,
  PRIMARY KEY (posting_id, skill_id),
  CONSTRAINT fk_ps_posting FOREIGN KEY (posting_id) REFERENCES job_postings(posting_id) ON DELETE CASCADE,
  CONSTRAINT fk_ps_skill   FOREIGN KEY (skill_id)   REFERENCES skills(skill_id)         ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Applications.  Five statuses. One application per person per
-- posting, enforced by the unique key rather than by the app.
-- ------------------------------------------------------------
CREATE TABLE applications (
  application_id INT AUTO_INCREMENT PRIMARY KEY,
  seeker_id      INT NOT NULL,
  resume_id      INT NOT NULL,
  posting_id     INT NOT NULL,
  status         ENUM('submitted','review','shortlisted','rejected','hired') NOT NULL DEFAULT 'submitted',
  score_snapshot TINYINT UNSIGNED NULL,            -- the score at the moment of applying
  applied_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_seeker_posting (seeker_id, posting_id),
  CONSTRAINT fk_app_seeker  FOREIGN KEY (seeker_id)  REFERENCES users(user_id)          ON DELETE CASCADE,
  CONSTRAINT fk_app_resume  FOREIGN KEY (resume_id)  REFERENCES resumes(resume_id)      ON DELETE CASCADE,
  CONSTRAINT fk_app_posting FOREIGN KEY (posting_id) REFERENCES job_postings(posting_id) ON DELETE CASCADE,
  INDEX idx_app_posting (posting_id),
  INDEX idx_app_status (status)
) ENGINE=InnoDB;

-- NEW (additive to the ERD). Every status change is attributable
-- to a named human recruiter. This is the audit trail that backs
-- the paper's claim that the system never decides anything.
CREATE TABLE application_status_history (
  history_id     INT AUTO_INCREMENT PRIMARY KEY,
  application_id INT NOT NULL,
  old_status     ENUM('submitted','review','shortlisted','rejected','hired') NULL,
  new_status     ENUM('submitted','review','shortlisted','rejected','hired') NOT NULL,
  changed_by     INT NULL,                         -- the recruiter who did it
  changed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hist_app  FOREIGN KEY (application_id) REFERENCES applications(application_id) ON DELETE CASCADE,
  CONSTRAINT fk_hist_user FOREIGN KEY (changed_by)     REFERENCES users(user_id)               ON DELETE SET NULL,
  INDEX idx_hist_app (application_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Cached scores (optional). The engine computes live; this table
-- exists so the study can show scores over time and so a large
-- applicant pool doesn't need recomputing on every page load.
-- ------------------------------------------------------------
CREATE TABLE match_scores (
  match_id            INT AUTO_INCREMENT PRIMARY KEY,
  resume_id           INT NOT NULL,
  posting_id          INT NOT NULL,
  compatibility_score TINYINT UNSIGNED NOT NULL,   -- 0..100
  skills_matched      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  skills_required     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  edu_meets           TINYINT(1) NOT NULL DEFAULT 0,
  exp_meets           TINYINT(1) NOT NULL DEFAULT 0,
  computed_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_resume_posting (resume_id, posting_id),
  CONSTRAINT fk_ms_resume  FOREIGN KEY (resume_id)  REFERENCES resumes(resume_id)       ON DELETE CASCADE,
  CONSTRAINT fk_ms_posting FOREIGN KEY (posting_id) REFERENCES job_postings(posting_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Matching settings. The paper says the weights are "refined
-- iteratively" — so they are a row you can edit, not a constant
-- buried in code. Change them here and BOTH the PHP engine and
-- the JS front end pick them up.
-- ------------------------------------------------------------
CREATE TABLE match_settings (
  setting_key   VARCHAR(40) PRIMARY KEY,
  setting_value DECIMAL(6,2) NOT NULL,
  note          VARCHAR(200)
) ENGINE=InnoDB;

INSERT INTO match_settings (setting_key, setting_value, note) VALUES
  ('weight_skills',     0.50, 'Share of the score from required-skill overlap'),
  ('weight_education',  0.25, 'Share of the score from meeting the education level'),
  ('weight_experience', 0.25, 'Share of the score from meeting the months required'),
  ('threshold_strong',  80.00, 'At or above this, a match is Strong'),
  ('threshold_related', 50.00, 'Below this, related roles are suggested — never a rejection');
