<?php
/* ResumeMatch PH — api/postings.php : list · mine · get · save · toggle */
declare(strict_types=1);
require_once __DIR__ . '/_lib.php';

switch (action()) {

// Public: every open position. Browsing needs no account.
case 'list': {
  $rows = db()->query("SELECT * FROM job_postings WHERE status='open' ORDER BY created_at DESC")->fetchAll();
  ok(['postings' => array_map(fn($p) => serialize_posting($p), $rows)]);
}

// Recruiter: every posting of MY company, open or closed, with counts.
case 'mine': {
  $u  = require_role('recruiter');
  $st = db()->prepare('SELECT * FROM job_postings WHERE company_id = ? ORDER BY created_at DESC');
  $st->execute([(int)$u['company_id']]);

  $out = [];
  foreach ($st->fetchAll() as $p) {
    $row = serialize_posting($p);
    $c = db()->prepare("SELECT
          COUNT(*) AS total,
          SUM(status = 'submitted') AS fresh
        FROM applications WHERE posting_id = ?");
    $c->execute([(int)$p['posting_id']]);
    $n = $c->fetch();
    $row['applicantCount'] = (int)$n['total'];
    $row['newCount']       = (int)$n['fresh'];
    $out[] = $row;
  }
  ok(['postings' => $out]);
}

case 'get': {
  $p = fetch_posting((int)inp('id'));
  if (!$p) fail('That opening no longer exists.');
  ok(['posting' => serialize_posting($p)]);
}

case 'save': {
  $u = require_role('recruiter');
  $P = inp('posting');
  if (!is_array($P)) fail('Nothing to save.');

  $title = trim((string)($P['title'] ?? ''));
  $dept  = trim((string)($P['department'] ?? ''));
  $desc  = trim((string)($P['description'] ?? ''));
  $skills = array_values(array_filter(array_map('trim', (array)($P['skills'] ?? []))));

  if (mb_strlen($title) < 2) fail('Give the opening a title.');
  if ($dept === '')          fail('Which department is this for?');
  if (mb_strlen($desc) < 10) fail('Describe the role in a sentence or two.');
  if (!$skills)              fail('Add at least one required skill — it\'s half the score.');

  $edu = in_array($P['educationLevel'] ?? '', array_keys(EDU_RANK), true) ? $P['educationLevel'] : 'bachelor';
  $type = in_array($P['employmentType'] ?? '', ['full-time','part-time','contract','internship'], true)
          ? $P['employmentType'] : 'full-time';
  $months = max(0, (int)($P['minExperienceMonths'] ?? 0));

  $pdo = db();
  $pdo->beginTransaction();
  try {
    $id = isset($P['id']) && $P['id'] !== null ? (int)$P['id'] : 0;

    if ($id) {
      $own = fetch_posting($id);
      if (!$own || (int)$own['company_id'] !== (int)$u['company_id']) {
        $pdo->rollBack(); fail('You can only edit your own company\'s openings.', 403);
      }
      $pdo->prepare('UPDATE job_postings SET title=?, department=?, employment_type=?, description=?, education_level=?, min_experience_months=? WHERE posting_id=?')
          ->execute([$title, $dept, $type, $desc, $edu, $months, $id]);
    } else {
      $pdo->prepare('INSERT INTO job_postings (company_id, created_by, title, department, employment_type, description, education_level, min_experience_months, status)
                     VALUES (?,?,?,?,?,?,?,?,"open")')
          ->execute([(int)$u['company_id'], (int)$u['user_id'], $title, $dept, $type, $desc, $edu, $months]);
      $id = (int)$pdo->lastInsertId();
    }

    $pdo->prepare('DELETE FROM posting_skills WHERE posting_id = ?')->execute([$id]);
    foreach ($skills as $s)
      $pdo->prepare('INSERT IGNORE INTO posting_skills (posting_id, skill_id) VALUES (?,?)')->execute([$id, skill_id($s)]);

    $pdo->commit();
  } catch (Throwable $e) {
    $pdo->rollBack();
    fail(DEBUG ? 'Save failed: ' . $e->getMessage() : 'The opening couldn\'t be saved. Try again.', 500);
  }
  ok(['posting' => serialize_posting(fetch_posting($id))]);
}

// Closing an opening stops NEW applications. It never removes the
// people who already applied — they stay on the ranked list.
case 'toggle': {
  $u  = require_role('recruiter');
  $id = (int)inp('id');
  $p  = fetch_posting($id);
  if (!$p || (int)$p['company_id'] !== (int)$u['company_id']) fail('Opening not found.');

  $next = $p['status'] === 'open' ? 'closed' : 'open';
  db()->prepare('UPDATE job_postings SET status = ? WHERE posting_id = ?')->execute([$next, $id]);
  ok(['posting' => serialize_posting(fetch_posting($id))]);
}

default:
  fail('Unknown action.', 400);
}
