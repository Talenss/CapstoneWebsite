-- ============================================================
-- ResumeMatch PH — the COMPLETE database in one file
-- (Angular + Node edition · 05_Website_Angular)
--
-- Schema + demo data together. This file is self-contained:
-- everything the Node server needs is created here, including
-- the tables/columns added since the original 04_Website schema
-- (admin role, email codes, notification preference, posting
-- deadlines, saved jobs). The server's startup migrations stay
-- idempotent, so booting against this database changes nothing.
--
-- Target: MySQL 8.x / MariaDB 10.4+ (XAMPP)
--
-- ONE command sets everything up:
--   mysql -u root < db/resumematch_ph.sql
-- (or import this single file via phpMyAdmin's Import tab)
--
-- Every demo account's password is:  demo123
--
-- Matching weights (initial, refined iteratively per the paper):
--   skills 0.50 · education 0.25 · experience 0.25
--   strong match >= 80 · related-role fallback < 50
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
-- Users.  One table, three roles.
--   seeker    — self-registers (with email verification)
--   recruiter — PROVISIONED: approved by an admin at /admin,
--               never self-registered
--   admin     — the research team; created only via
--               `npm run create-admin`
-- email_notifications: the per-user opt-out for application
-- update emails and job alerts (security codes always arrive).
-- ------------------------------------------------------------
CREATE TABLE users (
  user_id             INT AUTO_INCREMENT PRIMARY KEY,
  role                ENUM('seeker','recruiter','admin') NOT NULL DEFAULT 'seeker',
  full_name           VARCHAR(120) NOT NULL,
  email               VARCHAR(160) NOT NULL UNIQUE,
  password_hash       VARCHAR(255) NOT NULL,          -- bcrypt
  active_resume_id    INT NULL,                       -- FK added after `resumes` exists
  -- recruiter-only columns
  company_id          INT NULL,
  position_title      VARCHAR(120) NULL,
  verified            TINYINT(1) NOT NULL DEFAULT 0,  -- a recruiter cannot log in until this is 1
  email_notifications TINYINT(1) NOT NULL DEFAULT 1,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login_at       DATETIME NULL,
  CONSTRAINT fk_user_company FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE SET NULL,
  INDEX idx_users_role (role)
) ENGINE=InnoDB;

-- Public "request recruiter access" submissions, reviewed at /admin.
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

-- The 6-digit codes behind email verification (sign-up and email
-- change) and password reset. Rows are short-lived by design.
CREATE TABLE email_codes (
  code_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email       VARCHAR(190) NOT NULL,
  purpose     ENUM('verify','reset') NOT NULL,
  code        CHAR(6) NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code_id),
  KEY idx_email_purpose (email, purpose)
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
  own_file_path VARCHAR(255) NULL,                 -- server/uploads/, never web-reachable
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
-- Job postings.  application_deadline is optional; past it, the
-- posting stops accepting applications by itself (lazy
-- auto-close — no cron, nothing for HR to remember).
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
  application_deadline  DATE NULL,
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

-- A seeker's bookmarked openings.
CREATE TABLE saved_jobs (
  user_id     INT NOT NULL,
  posting_id  INT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, posting_id),
  CONSTRAINT fk_saved_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_posting FOREIGN KEY (posting_id) REFERENCES job_postings(posting_id) ON DELETE CASCADE
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

-- Every status change is attributable to a named human recruiter.
-- This is the audit trail that backs the paper's claim that the
-- system never decides anything.
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
-- buried in code. Change them here and the engine picks them up.
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

-- ============================================================
-- DEMO DATA — the same dataset the browser demo uses, so the
-- Node backend behaves identically to what you tested offline.
-- Every account's password: demo123
-- ============================================================

SET @pw := '$2y$12$99r3f85tx.CU49v3eRoKE.DXfHiRQ9YNUyCliZfGvjnARdtwGpZO6'; -- demo123

-- ---------- company ----------
INSERT INTO companies (company_id, company_name, industry, location, about, website) VALUES
 (1, 'Royce Hotel & Casino', 'Hospitality & Gaming',
     'Manuel A. Roxas Highway, Clark Freeport Zone, Mabalacat, Pampanga',
     'An integrated hotel and entertainment destination in Clark Freeport Zone — 500 rooms across two buildings, ten dining venues, event ballrooms, a spa, and a gaming floor. Pilot partner of this study, hiring across front office, food & beverage, housekeeping, IT, human resources, and marketing.',
     'https://www.roycehotelandcasino.com');

-- ---------- users ----------
-- Recruiter (provisioned & verified) + four job seekers.
-- To create the research-team ADMIN account, run:
--   cd server && npm run create-admin -- you@example.com "a strong password"
INSERT INTO users (user_id, role, full_name, email, password_hash, company_id, position_title, verified) VALUES
 (2, 'recruiter', 'Maria Santos', 'hr@demo.ph', @pw, 1, 'HR Officer', 1);

INSERT INTO users (user_id, role, full_name, email, password_hash) VALUES
 (1, 'seeker', 'Juan Dela Cruz', 'seeker@demo.ph', @pw),
 (3, 'seeker', 'Ana Reyes',      'ana@demo.ph',    @pw),
 (4, 'seeker', 'Marco Garcia',   'marco@demo.ph',  @pw),
 (5, 'seeker', 'Liza Cruz',      'liza@demo.ph',   @pw);

-- ---------- skills (canonical rows) ----------
INSERT INTO skills (skill_name, skill_norm, category) VALUES
 ('HTML/CSS','htmlcss','technical'), ('JavaScript','javascript','technical'),
 ('MySQL','mysql','technical'), ('Troubleshooting','troubleshooting','technical'),
 ('Windows','windows','technical'), ('Networking','networking','technical'),
 ('POS','pos','technical'), ('Canva','canva','technical'),
 ('Copywriting','copywriting','technical'), ('HRIS','hris','technical'),
 ('Teamwork','teamwork','soft'), ('Communication','communication','soft'),
 ('Customer Service','customerservice','soft'), ('English Proficiency','englishproficiency','soft'),
 ('Food Safety','foodsafety','soft'), ('MS Office','msoffice','technical'),
 ('Recruitment','recruitment','soft'), ('Organization','organization','soft'),
 ('Social Media','socialmedia','technical'), ('Leadership','leadership','soft'),
 ('Scheduling','scheduling','soft'), ('Housekeeping Operations','housekeepingoperations','technical');

-- ---------- resumes ----------
INSERT INTO resumes (resume_id, user_id, title, template_type, full_name, email, phone, address, summary) VALUES
 (1, 1, 'IT — fresh graduate', 'chronological', 'Juan Dela Cruz', 'seeker@demo.ph', '0917 000 0000', 'San Fernando, Pampanga',
     'BS Information Technology graduate with internship experience building and maintaining public-facing web pages. Looking for an entry-level web developer role.'),
 (2, 3, 'Computer Science — fresh graduate', 'chronological', 'Ana Reyes', 'ana@demo.ph', '0917 111 1111', 'Mabalacat, Pampanga',
     'BS Computer Science graduate with coursework projects in front-end development. Seeking a junior developer role.'),
 (3, 4, 'Hospitality Management', 'chronological', 'Marco Garcia', 'marco@demo.ph', '0917 222 2222', 'Angeles City, Pampanga',
     'Hospitality Management graduate with food & beverage internship experience at a Clark hotel.'),
 (4, 5, 'HR & Marketing', 'combination', 'Liza Cruz', 'liza@demo.ph', '0917 333 3333', 'San Fernando, Pampanga',
     'Psychology graduate with HR internship exposure and social media management for a student organization.');

UPDATE users SET active_resume_id = 1 WHERE user_id = 1;
UPDATE users SET active_resume_id = 2 WHERE user_id = 3;
UPDATE users SET active_resume_id = 3 WHERE user_id = 4;
UPDATE users SET active_resume_id = 4 WHERE user_id = 5;

INSERT INTO education (resume_id, school, degree, level, year_grad) VALUES
 (1, 'Holy Angel University', 'BS Information Technology', 'bachelor', '2026'),
 (2, 'Angeles University Foundation', 'BS Computer Science', 'bachelor', '2026'),
 (3, 'Holy Angel University', 'BS Hospitality Management', 'bachelor', '2025'),
 (4, 'University of the Assumption', 'BA Psychology', 'bachelor', '2025');

INSERT INTO work_experience (resume_id, position, company, months, description) VALUES
 (1, 'Web Development Intern', 'LGU San Fernando', 4, 'Built and maintained pages for the city job portal; fixed layout issues reported by staff.'),
 (2, 'Capstone Developer', 'Angeles University Foundation', 3, 'Built a school event portal with a team of four.'),
 (3, 'F&B Intern', 'Clark hotel', 6, 'Served 60+ covers per shift; handled POS billing and table turnover.'),
 (4, 'HR Intern', 'Manufacturing firm', 8, 'Assisted in screening, interview scheduling, and 201 filing.');

INSERT INTO certifications (resume_id, cert_name, year_taken) VALUES
 (1, 'TESDA Web Development NC III', '2025'),
 (3, 'Food Safety Training', '2025');

-- resume_skills — join by the normalized skill name
INSERT INTO resume_skills (resume_id, skill_id)
SELECT 1, skill_id FROM skills WHERE skill_norm IN ('htmlcss','javascript','mysql','teamwork','communication');
INSERT INTO resume_skills (resume_id, skill_id)
SELECT 2, skill_id FROM skills WHERE skill_norm IN ('htmlcss','javascript','communication','teamwork');
INSERT INTO resume_skills (resume_id, skill_id)
SELECT 3, skill_id FROM skills WHERE skill_norm IN ('customerservice','communication','msoffice','englishproficiency','pos','teamwork','foodsafety');
INSERT INTO resume_skills (resume_id, skill_id)
SELECT 4, skill_id FROM skills WHERE skill_norm IN ('communication','recruitment','msoffice','organization','socialmedia');

-- ---------- job postings ----------
-- Posting 6 gets a deadline two weeks out, demoing the "Apply by" chip.
INSERT INTO job_postings (posting_id, company_id, created_by, title, department, employment_type, description, education_level, min_experience_months, application_deadline, status) VALUES
 (1, 1, 2, 'Junior Web Developer', 'IT', 'full-time',
     'Maintain the hotel website, online booking pages, and internal web tools under the IT supervisor. Fresh graduates are welcome to apply.', 'bachelor', 0, NULL, 'open'),
 (2, 1, 2, 'IT Support Associate', 'IT', 'full-time',
     'First-line technical support for the front office, gaming floor, and back-office systems.', 'bachelor', 0, NULL, 'open'),
 (3, 1, 2, 'Front Office Associate', 'Front Office', 'full-time',
     'Handle guest check-in and check-out, reservations, and inquiries at the front desk of the Premium Building.', 'bachelor', 0, NULL, 'open'),
 (4, 1, 2, 'F&B Service Attendant', 'Food & Beverage', 'full-time',
     'Serve guests across the hotel restaurants and banquet events; uphold food safety standards.', 'highschool', 0, NULL, 'open'),
 (5, 1, 2, 'HR Assistant', 'Human Resources', 'full-time',
     'Assist in recruitment scheduling, 201 files, and onboarding of new hires.', 'bachelor', 0, NULL, 'open'),
 (6, 1, 2, 'Marketing Associate', 'Marketing', 'full-time',
     'Support promotions, events, and social media for the hotel and casino.', 'bachelor', 6, DATE_ADD(CURDATE(), INTERVAL 14 DAY), 'open'),
 (7, 1, 2, 'Housekeeping Team Leader', 'Housekeeping', 'full-time',
     'Lead a room-attendant team across the Deluxe Building; manage schedules and quality inspections.', 'highschool', 12, NULL, 'open');

INSERT INTO posting_skills (posting_id, skill_id) SELECT 1, skill_id FROM skills WHERE skill_norm IN ('htmlcss','javascript','mysql','teamwork');
INSERT INTO posting_skills (posting_id, skill_id) SELECT 2, skill_id FROM skills WHERE skill_norm IN ('troubleshooting','windows','networking','communication');
INSERT INTO posting_skills (posting_id, skill_id) SELECT 3, skill_id FROM skills WHERE skill_norm IN ('customerservice','communication','msoffice','englishproficiency');
INSERT INTO posting_skills (posting_id, skill_id) SELECT 4, skill_id FROM skills WHERE skill_norm IN ('customerservice','teamwork','foodsafety','pos');
INSERT INTO posting_skills (posting_id, skill_id) SELECT 5, skill_id FROM skills WHERE skill_norm IN ('communication','msoffice','recruitment','organization');
INSERT INTO posting_skills (posting_id, skill_id) SELECT 6, skill_id FROM skills WHERE skill_norm IN ('socialmedia','copywriting','canva','communication');
INSERT INTO posting_skills (posting_id, skill_id) SELECT 7, skill_id FROM skills WHERE skill_norm IN ('housekeepingoperations','leadership','scheduling','teamwork');

-- ---------- applications (with status history, so the audit trail isn't empty) ----------
INSERT INTO applications (application_id, seeker_id, resume_id, posting_id, status, score_snapshot, applied_at) VALUES
 (1, 3, 2, 1, 'review',      88, NOW() - INTERVAL 3 DAY),
 (2, 4, 3, 1, 'submitted',   63, NOW() - INTERVAL 2 DAY),
 (3, 4, 3, 3, 'shortlisted', 75, NOW() - INTERVAL 4 DAY),
 (4, 5, 4, 5, 'review',      75, NOW() - INTERVAL 3 DAY),
 (5, 5, 4, 6, 'submitted',   50, NOW() - INTERVAL 1 DAY);

INSERT INTO application_status_history (application_id, old_status, new_status, changed_by, changed_at) VALUES
 (1, NULL, 'submitted', 3, NOW() - INTERVAL 3 DAY), (1, 'submitted', 'review', 2, NOW() - INTERVAL 2 DAY),
 (2, NULL, 'submitted', 4, NOW() - INTERVAL 2 DAY),
 (3, NULL, 'submitted', 4, NOW() - INTERVAL 4 DAY), (3, 'submitted', 'review', 2, NOW() - INTERVAL 3 DAY), (3, 'review', 'shortlisted', 2, NOW() - INTERVAL 2 DAY),
 (4, NULL, 'submitted', 5, NOW() - INTERVAL 3 DAY), (4, 'submitted', 'review', 2, NOW() - INTERVAL 2 DAY),
 (5, NULL, 'submitted', 5, NOW() - INTERVAL 1 DAY);

-- Marco (resume 3) has an uploaded file in the demo. On the server you'd
-- attach it through the UI; there's no file on disk to point at from SQL,
-- so this is left unset here and works the moment he uploads one.
