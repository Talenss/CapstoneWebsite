-- ============================================================
-- ResumeMatch PH — seed data
-- ------------------------------------------------------------
-- The SAME dataset the browser demo uses, so the PHP backend
-- behaves identically to what you tested in demo mode.
--
-- Every demo account's password is:  demo123
-- (stored as a real bcrypt hash below — PHP's password_verify
--  accepts it as-is; nothing to fill in.)
--
-- Run AFTER schema.sql:
--   mysql -u root resumematch_ph < db/seed.sql
-- ============================================================
USE resumematch_ph;

SET @pw := '$2y$12$99r3f85tx.CU49v3eRoKE.DXfHiRQ9YNUyCliZfGvjnARdtwGpZO6'; -- demo123

-- ---------- company ----------
INSERT INTO companies (company_id, company_name, industry, location, about, website) VALUES
 (1, 'Royce Hotel & Casino', 'Hospitality & Gaming',
     'Manuel A. Roxas Highway, Clark Freeport Zone, Mabalacat, Pampanga',
     'An integrated hotel and entertainment destination in Clark Freeport Zone — 500 rooms across two buildings, ten dining venues, event ballrooms, a spa, and a gaming floor. Pilot partner of this study, hiring across front office, food & beverage, housekeeping, IT, human resources, and marketing.',
     'https://www.roycehotelandcasino.com');

-- ---------- users ----------
-- Recruiter (provisioned & verified) + four job seekers.
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
INSERT INTO job_postings (posting_id, company_id, created_by, title, department, employment_type, description, education_level, min_experience_months, status) VALUES
 (1, 1, 2, 'Junior Web Developer', 'IT', 'full-time',
     'Maintain the hotel website, online booking pages, and internal web tools under the IT supervisor. Fresh graduates are welcome to apply.', 'bachelor', 0, 'open'),
 (2, 1, 2, 'IT Support Associate', 'IT', 'full-time',
     'First-line technical support for the front office, gaming floor, and back-office systems.', 'bachelor', 0, 'open'),
 (3, 1, 2, 'Front Office Associate', 'Front Office', 'full-time',
     'Handle guest check-in and check-out, reservations, and inquiries at the front desk of the Premium Building.', 'bachelor', 0, 'open'),
 (4, 1, 2, 'F&B Service Attendant', 'Food & Beverage', 'full-time',
     'Serve guests across the hotel restaurants and banquet events; uphold food safety standards.', 'highschool', 0, 'open'),
 (5, 1, 2, 'HR Assistant', 'Human Resources', 'full-time',
     'Assist in recruitment scheduling, 201 files, and onboarding of new hires.', 'bachelor', 0, 'open'),
 (6, 1, 2, 'Marketing Associate', 'Marketing', 'full-time',
     'Support promotions, events, and social media for the hotel and casino.', 'bachelor', 6, 'open'),
 (7, 1, 2, 'Housekeeping Team Leader', 'Housekeeping', 'full-time',
     'Lead a room-attendant team across the Deluxe Building; manage schedules and quality inspections.', 'highschool', 12, 'open');

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
