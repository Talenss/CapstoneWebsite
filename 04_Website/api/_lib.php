<?php
/* ============================================================
   ResumeMatch PH — shared library (api/_lib.php)
   ------------------------------------------------------------
   PDO, session, JSON, auth guards, the matching engine, and the
   row → JSON serializers. Every endpoint includes this first.

   The JSON shapes emitted here are exactly what assets/api.js
   expects, so flipping CONFIG.mode from 'demo' to 'php' needs
   no change to any page.
   ============================================================ */

declare(strict_types=1);
require_once __DIR__ . '/config.php';

if (DEBUG) { ini_set('display_errors', '0'); error_reporting(E_ALL); }

/* ---------- session ---------- */
session_set_cookie_params([
  'lifetime' => 0,
  'path'     => '/',
  'httponly' => true,                                    // JS cannot read the session cookie
  'samesite' => 'Lax',
  'secure'   => !empty($_SERVER['HTTPS']),
]);
session_name('RMPHSESS');
session_start();

/* ---------- headers ---------- */
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
if (ALLOW_ORIGIN !== '') {
  header('Access-Control-Allow-Origin: ' . ALLOW_ORIGIN);
  header('Access-Control-Allow-Credentials: true');
  header('Access-Control-Allow-Headers: Content-Type');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

/* ---------- responses ---------- */
function ok(array $data = []): never {
  echo json_encode(array_merge(['ok' => true], $data), JSON_UNESCAPED_UNICODE);
  exit;
}
function fail(string $message, int $code = 200): never {
  http_response_code($code);
  echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
  exit;
}

/* ---------- database ---------- */
function db(): PDO {
  static $pdo = null;
  if ($pdo instanceof PDO) return $pdo;
  $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', DB_HOST, DB_PORT, DB_NAME);
  try {
    $pdo = new PDO($dsn, DB_USER, DB_PASS, [
      PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
      PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
      PDO::ATTR_EMULATE_PREPARES   => false,             // real prepared statements
    ]);
  } catch (PDOException $e) {
    fail(DEBUG
      ? 'Database connection failed: ' . $e->getMessage()
      : 'The service is unavailable. Try again shortly.', 500);
  }
  return $pdo;
}

/* ---------- request body ---------- */
function body(): array {
  static $cache = null;
  if ($cache !== null) return $cache;
  $raw = file_get_contents('php://input');
  $j = json_decode($raw ?: '[]', true);
  $cache = is_array($j) ? $j : [];
  return $cache;
}
function inp(string $key, $default = null) {
  $b = body();
  return array_key_exists($key, $b) ? $b[$key] : $default;
}
function action(): string {
  return (string)($_GET['action'] ?? '');
}

/* ---------- auth guards ---------- */
function current_user(): ?array {
  if (empty($_SESSION['uid'])) return null;
  $st = db()->prepare('SELECT * FROM users WHERE user_id = ? LIMIT 1');
  $st->execute([$_SESSION['uid']]);
  $u = $st->fetch();
  return $u ?: null;
}
function require_user(): array {
  $u = current_user();
  if (!$u) fail('You are not signed in.', 401);
  return $u;
}
function require_role(string $role): array {
  $u = require_user();
  if ($u['role'] !== $role) fail('You don\'t have access to that.', 403);
  return $u;
}

/* ============================================================
   MATCHING ENGINE
   Mirrors assets/api.js score() exactly. Rule-based only —
   no ML, no AI, per the paper's delimitations. The applicant's
   uploaded file is never opened here.
   ============================================================ */

const EDU_RANK = ['none' => 0, 'highschool' => 1, 'vocational' => 2,
                  'associate' => 3, 'bachelor' => 4, 'master' => 5];

function skill_norm(string $s): string {
  return preg_replace('/[^a-z0-9]/', '', strtolower($s)) ?? '';
}

/** Weights and thresholds come from the DB, so "refined iteratively"
 *  means editing a row — not redeploying code. */
function settings(): array {
  static $s = null;
  if ($s !== null) return $s;
  $rows = db()->query('SELECT setting_key, setting_value FROM match_settings')->fetchAll();
  $map = [];
  foreach ($rows as $r) $map[$r['setting_key']] = (float)$r['setting_value'];
  $s = [
    'weights' => [
      'skills'     => $map['weight_skills']     ?? 0.50,
      'education'  => $map['weight_education']  ?? 0.25,
      'experience' => $map['weight_experience'] ?? 0.25,
    ],
    'thresholds' => [
      'strong'  => (int)($map['threshold_strong']  ?? 80),
      'related' => (int)($map['threshold_related'] ?? 50),
    ],
  ];
  return $s;
}

/**
 * @param array $resume  serialized resume (see serialize_resume)
 * @param array $posting serialized posting (see serialize_posting)
 */
function rm_score(array $resume, array $posting): array {
  $cfg = settings();
  $W = $cfg['weights'];
  $T = $cfg['thresholds'];

  $required = $posting['skills'] ?? [];
  $have = [];
  foreach (($resume['skills'] ?? []) as $s) $have[skill_norm($s)] = true;

  $matched = $missing = [];
  foreach ($required as $s) {
    if (isset($have[skill_norm($s)])) $matched[] = $s; else $missing[] = $s;
  }
  $skillPart = count($required) ? count($matched) / count($required) : 1.0;

  $seekerEdu = 0;
  foreach (($resume['education'] ?? []) as $e) {
    $seekerEdu = max($seekerEdu, EDU_RANK[$e['level']] ?? 0);
  }
  $reqEdu  = EDU_RANK[$posting['educationLevel']] ?? 0;
  $eduPart = $reqEdu === 0 ? 1.0 : min(1.0, $seekerEdu / $reqEdu);

  $months = 0;
  foreach (($resume['experience'] ?? []) as $e) $months += (int)($e['months'] ?? 0);
  $reqMonths = (int)($posting['minExperienceMonths'] ?? 0);
  $expPart   = $reqMonths <= 0 ? 1.0 : min(1.0, $months / $reqMonths);

  $raw   = ($skillPart * $W['skills'] + $eduPart * $W['education'] + $expPart * $W['experience']) * 100;
  $total = (int)floor($raw + 0.5);   // half-up, explicitly — must match assets/api.js score()

  return [
    'score'         => $total,
    'matchedSkills' => $matched,
    'missingSkills' => $missing,
    'totalSkills'   => count($required),
    'eduMeets'      => $eduPart >= 1.0,
    'expMeets'      => $expPart >= 1.0,
    'seekerMonths'  => $months,
    'tier'          => $total >= $T['strong'] ? 'strong' : ($total >= $T['related'] ? 'possible' : 'related'),
  ];
}

/** Cache a computed score so the study can report on it later. */
function cache_score(int $resumeId, int $postingId, array $s): void {
  $st = db()->prepare(
    'INSERT INTO match_scores (resume_id, posting_id, compatibility_score, skills_matched, skills_required, edu_meets, exp_meets)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE compatibility_score=VALUES(compatibility_score), skills_matched=VALUES(skills_matched),
       skills_required=VALUES(skills_required), edu_meets=VALUES(edu_meets), exp_meets=VALUES(exp_meets)');
  $st->execute([$resumeId, $postingId, $s['score'], count($s['matchedSkills']),
                $s['totalSkills'], $s['eduMeets'] ? 1 : 0, $s['expMeets'] ? 1 : 0]);
}

/* ============================================================
   SKILLS — one canonical row per skill, so "MySQL" on a resume
   and "MySQL" on a posting are literally the same row.
   ============================================================ */
function skill_id(string $name): int {
  $name = trim($name);
  $norm = skill_norm($name);
  $st = db()->prepare('SELECT skill_id FROM skills WHERE skill_norm = ? LIMIT 1');
  $st->execute([$norm]);
  $id = $st->fetchColumn();
  if ($id) return (int)$id;
  $ins = db()->prepare('INSERT INTO skills (skill_name, skill_norm) VALUES (?,?)');
  $ins->execute([$name, $norm]);
  return (int)db()->lastInsertId();
}

/* ============================================================
   SERIALIZERS — DB rows → the exact JSON assets/api.js expects.
   IDs are cast to strings so the front end can compare with ===
   the same way it does in demo mode.
   ============================================================ */

function serialize_user(?array $u): ?array {
  if (!$u) return null;
  $out = [
    'id'        => (string)$u['user_id'],
    'role'      => $u['role'],
    'name'      => $u['full_name'],
    'email'     => $u['email'],
    'createdAt' => strtotime((string)$u['created_at']) * 1000,
  ];
  if ($u['role'] === 'seeker') {
    $out['activeResumeId'] = $u['active_resume_id'] !== null ? (string)$u['active_resume_id'] : null;
  } else {
    $out['companyId'] = $u['company_id'] !== null ? (string)$u['company_id'] : null;
    $out['position']  = $u['position_title'];
    $out['verified']  = (bool)$u['verified'];
  }
  return $out;                                            // password_hash is never included
}

function serialize_company(array $c): array {
  return [
    'id'       => (string)$c['company_id'],
    'name'     => $c['company_name'],
    'industry' => $c['industry'],
    'location' => $c['location'],
    'about'    => $c['about'],
    'website'  => $c['website'],
  ];
}

function serialize_resume(array $r): array {
  $id = (int)$r['resume_id'];

  $edu = db()->prepare('SELECT school, degree, level, year_grad FROM education WHERE resume_id=? ORDER BY sort_order, education_id');
  $edu->execute([$id]);
  $education = array_map(fn($e) => [
    'school' => $e['school'], 'degree' => $e['degree'],
    'level'  => $e['level'],  'year'   => $e['year_grad'],
  ], $edu->fetchAll());

  $exp = db()->prepare('SELECT position, company, months, description FROM work_experience WHERE resume_id=? ORDER BY sort_order, experience_id');
  $exp->execute([$id]);
  $experience = array_map(fn($e) => [
    'position' => $e['position'], 'company' => $e['company'],
    'months'   => (int)$e['months'], 'description' => $e['description'],
  ], $exp->fetchAll());

  $sk = db()->prepare('SELECT s.skill_name FROM resume_skills rs JOIN skills s ON s.skill_id=rs.skill_id WHERE rs.resume_id=? ORDER BY s.skill_name');
  $sk->execute([$id]);
  $skills = array_column($sk->fetchAll(), 'skill_name');

  $ce = db()->prepare('SELECT cert_name, year_taken FROM certifications WHERE resume_id=? ORDER BY sort_order, certification_id');
  $ce->execute([$id]);
  $certs = array_map(fn($c) => ['name' => $c['cert_name'], 'year' => $c['year_taken']], $ce->fetchAll());

  // The uploaded file: metadata only. The bytes are served by file.php,
  // which checks who is asking. There is no public URL to this document.
  $ownFile = $r['own_file_name'] ? [
    'name'       => $r['own_file_name'],
    'mime'       => $r['own_file_mime'],
    'size'       => (int)$r['own_file_size'],
    'uploadedAt' => strtotime((string)$r['own_file_uploaded_at']) * 1000,
  ] : null;

  return [
    'id'       => (string)$id,
    'userId'   => (string)$r['user_id'],
    'title'    => $r['title'],
    'template' => $r['template_type'],
    'personal' => [
      'fullName' => $r['full_name'], 'email' => $r['email'], 'phone' => $r['phone'],
      'address'  => $r['address'],   'summary' => $r['summary'],
    ],
    'education'      => $education,
    'experience'     => $experience,
    'skills'         => $skills,
    'certifications' => $certs,
    'ownFile'        => $ownFile,
    'updatedAt'      => strtotime((string)$r['updated_at']) * 1000,
  ];
}

function serialize_posting(array $p, bool $withCompany = true): array {
  $st = db()->prepare('SELECT s.skill_name FROM posting_skills ps JOIN skills s ON s.skill_id=ps.skill_id WHERE ps.posting_id=? ORDER BY s.skill_name');
  $st->execute([(int)$p['posting_id']]);

  $out = [
    'id'                  => (string)$p['posting_id'],
    'companyId'           => (string)$p['company_id'],
    'title'               => $p['title'],
    'department'          => $p['department'],
    'employmentType'      => $p['employment_type'],
    'description'         => $p['description'],
    'skills'              => array_column($st->fetchAll(), 'skill_name'),
    'educationLevel'      => $p['education_level'],
    'minExperienceMonths' => (int)$p['min_experience_months'],
    'status'              => $p['status'],
    'createdAt'           => strtotime((string)$p['created_at']) * 1000,
  ];

  if ($withCompany) {
    $c = db()->prepare('SELECT * FROM companies WHERE company_id=?');
    $c->execute([(int)$p['company_id']]);
    $row = $c->fetch();
    if ($row) $out['company'] = serialize_company($row);
  }
  return $out;
}

function serialize_application(array $a): array {
  return [
    'id'        => (string)$a['application_id'],
    'seekerId'  => (string)$a['seeker_id'],
    'resumeId'  => (string)$a['resume_id'],
    'postingId' => (string)$a['posting_id'],
    'status'    => $a['status'],
    'appliedAt' => strtotime((string)$a['applied_at']) * 1000,
  ];
}

/* ---------- helpers ---------- */
function fetch_resume(int $id): ?array {
  $st = db()->prepare('SELECT * FROM resumes WHERE resume_id=?');
  $st->execute([$id]);
  $r = $st->fetch();
  return $r ?: null;
}
function fetch_posting(int $id): ?array {
  $st = db()->prepare('SELECT * FROM job_postings WHERE posting_id=?');
  $st->execute([$id]);
  $p = $st->fetch();
  return $p ?: null;
}

/** May this recruiter read this resume? Only if it was actually
 *  submitted to one of their company's openings. */
function recruiter_may_read_resume(array $recruiter, int $resumeId): bool {
  $st = db()->prepare(
    'SELECT 1 FROM applications a
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE a.resume_id = ? AND p.company_id = ? LIMIT 1');
  $st->execute([$resumeId, (int)$recruiter['company_id']]);
  return (bool)$st->fetchColumn();
}
