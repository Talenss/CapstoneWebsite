<?php
/* ResumeMatch PH — api/resumes.php
   list · get · save · delete · duplicate · set-active · upload · remove-file */
declare(strict_types=1);
require_once __DIR__ . '/_lib.php';

switch (action()) {

case 'list': {
  $u  = require_user();
  $st = db()->prepare('SELECT * FROM resumes WHERE user_id = ? ORDER BY updated_at DESC');
  $st->execute([(int)$u['user_id']]);
  ok(['resumes' => array_map('serialize_resume', $st->fetchAll())]);
}

case 'get': {
  $u  = require_user();
  $id = (int)inp('id');
  $r  = fetch_resume($id);
  if (!$r) fail('Resume not found.');

  if ($u['role'] === 'recruiter') {
    // A recruiter may read a resume only if it was submitted to their company.
    if (!recruiter_may_read_resume($u, $id)) fail('You can only view resumes submitted to your company.', 403);
  } elseif ((int)$r['user_id'] !== (int)$u['user_id']) {
    fail('You can only view your own resumes.', 403);
  }
  ok(['resume' => serialize_resume($r)]);
}

case 'save': {
  $u = require_role('seeker');
  $R = inp('resume');
  if (!is_array($R)) fail('Nothing to save.');

  $title    = trim((string)($R['title'] ?? '')) ?: 'Untitled resume';
  $template = in_array($R['template'] ?? '', ['chronological','functional','combination'], true)
              ? $R['template'] : 'chronological';
  $p = is_array($R['personal'] ?? null) ? $R['personal'] : [];

  $pdo = db();
  $pdo->beginTransaction();
  try {
    $id = isset($R['id']) && $R['id'] !== null ? (int)$R['id'] : 0;

    if ($id) {
      $own = fetch_resume($id);
      if (!$own || (int)$own['user_id'] !== (int)$u['user_id']) { $pdo->rollBack(); fail('You can only edit your own resumes.', 403); }
      $pdo->prepare('UPDATE resumes SET title=?, template_type=?, full_name=?, email=?, phone=?, address=?, summary=? WHERE resume_id=?')
          ->execute([$title, $template, $p['fullName'] ?? '', $p['email'] ?? '', $p['phone'] ?? '',
                     $p['address'] ?? '', $p['summary'] ?? '', $id]);
    } else {
      $pdo->prepare('INSERT INTO resumes (user_id, title, template_type, full_name, email, phone, address, summary) VALUES (?,?,?,?,?,?,?,?)')
          ->execute([(int)$u['user_id'], $title, $template, $p['fullName'] ?? '', $p['email'] ?? '',
                     $p['phone'] ?? '', $p['address'] ?? '', $p['summary'] ?? '']);
      $id = (int)$pdo->lastInsertId();
      // first resume becomes the active one automatically
      if ($u['active_resume_id'] === null)
        $pdo->prepare('UPDATE users SET active_resume_id = ? WHERE user_id = ?')->execute([$id, (int)$u['user_id']]);
    }

    // Children are replaced wholesale — simpler, and always consistent.
    // Written out rather than looped: a table name can't be a bound parameter,
    // so keeping any variable out of the SQL string keeps this obviously safe.
    $pdo->prepare('DELETE FROM education       WHERE resume_id = ?')->execute([$id]);
    $pdo->prepare('DELETE FROM work_experience WHERE resume_id = ?')->execute([$id]);
    $pdo->prepare('DELETE FROM certifications  WHERE resume_id = ?')->execute([$id]);
    $pdo->prepare('DELETE FROM resume_skills   WHERE resume_id = ?')->execute([$id]);

    $i = 0;
    foreach (($R['education'] ?? []) as $e) {
      $lvl = in_array($e['level'] ?? '', array_keys(EDU_RANK), true) ? $e['level'] : 'bachelor';
      $pdo->prepare('INSERT INTO education (resume_id, school, degree, level, year_grad, sort_order) VALUES (?,?,?,?,?,?)')
          ->execute([$id, $e['school'] ?? '', $e['degree'] ?? '', $lvl, $e['year'] ?? '', $i++]);
    }
    $i = 0;
    foreach (($R['experience'] ?? []) as $e) {
      $pdo->prepare('INSERT INTO work_experience (resume_id, position, company, months, description, sort_order) VALUES (?,?,?,?,?,?)')
          ->execute([$id, $e['position'] ?? '', $e['company'] ?? '', (int)($e['months'] ?? 0), $e['description'] ?? '', $i++]);
    }
    $i = 0;
    foreach (($R['certifications'] ?? []) as $c) {
      $pdo->prepare('INSERT INTO certifications (resume_id, cert_name, year_taken, sort_order) VALUES (?,?,?,?)')
          ->execute([$id, $c['name'] ?? '', $c['year'] ?? '', $i++]);
    }
    foreach (($R['skills'] ?? []) as $s) {
      $s = trim((string)$s);
      if ($s === '') continue;
      $pdo->prepare('INSERT IGNORE INTO resume_skills (resume_id, skill_id) VALUES (?,?)')
          ->execute([$id, skill_id($s)]);
    }

    $pdo->prepare('UPDATE resumes SET updated_at = NOW() WHERE resume_id = ?')->execute([$id]);
    $pdo->commit();
  } catch (Throwable $e) {
    $pdo->rollBack();
    fail(DEBUG ? 'Save failed: ' . $e->getMessage() : 'Your resume couldn\'t be saved. Try again.', 500);
  }

  ok(['resume' => serialize_resume(fetch_resume($id))]);
}

case 'delete': {
  $u  = require_role('seeker');
  $id = (int)inp('id');
  $r  = fetch_resume($id);
  if (!$r || (int)$r['user_id'] !== (int)$u['user_id']) fail('Resume not found.');

  // A resume attached to an application can't be deleted — the recruiter
  // still needs to see exactly what was sent to them.
  $st = db()->prepare('SELECT 1 FROM applications WHERE resume_id = ? LIMIT 1');
  $st->execute([$id]);
  if ($st->fetchColumn())
    fail('This resume is attached to an application, so it can\'t be deleted — the recruiter still needs to see exactly what you sent. Duplicate it and edit the copy instead.');

  if ($r['own_file_path']) {
    $path = UPLOAD_DIR . '/' . basename((string)$r['own_file_path']);
    if (is_file($path)) @unlink($path);
  }

  db()->prepare('UPDATE users SET active_resume_id = NULL WHERE active_resume_id = ?')->execute([$id]);
  db()->prepare('DELETE FROM resumes WHERE resume_id = ?')->execute([$id]);

  // promote whatever is left, so the dashboard is never left with nothing active
  $st = db()->prepare('SELECT resume_id FROM resumes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1');
  $st->execute([(int)$u['user_id']]);
  if ($next = $st->fetchColumn())
    db()->prepare('UPDATE users SET active_resume_id = ? WHERE user_id = ?')->execute([(int)$next, (int)$u['user_id']]);

  ok();
}

case 'duplicate': {
  $u  = require_role('seeker');
  $id = (int)inp('id');
  $r  = fetch_resume($id);
  if (!$r || (int)$r['user_id'] !== (int)$u['user_id']) fail('Resume not found.');

  $pdo = db();
  $pdo->beginTransaction();
  try {
    // the uploaded file is deliberately NOT copied — one file, one resume
    $pdo->prepare('INSERT INTO resumes (user_id, title, template_type, full_name, email, phone, address, summary)
                   SELECT user_id, CONCAT(title, " (copy)"), template_type, full_name, email, phone, address, summary
                     FROM resumes WHERE resume_id = ?')->execute([$id]);
    $new = (int)$pdo->lastInsertId();

    $pdo->prepare('INSERT INTO education (resume_id, school, degree, level, year_grad, sort_order)
                   SELECT ?, school, degree, level, year_grad, sort_order FROM education WHERE resume_id = ?')->execute([$new, $id]);
    $pdo->prepare('INSERT INTO work_experience (resume_id, position, company, months, description, sort_order)
                   SELECT ?, position, company, months, description, sort_order FROM work_experience WHERE resume_id = ?')->execute([$new, $id]);
    $pdo->prepare('INSERT INTO certifications (resume_id, cert_name, year_taken, sort_order)
                   SELECT ?, cert_name, year_taken, sort_order FROM certifications WHERE resume_id = ?')->execute([$new, $id]);
    $pdo->prepare('INSERT INTO resume_skills (resume_id, skill_id)
                   SELECT ?, skill_id FROM resume_skills WHERE resume_id = ?')->execute([$new, $id]);
    $pdo->commit();
  } catch (Throwable $e) {
    $pdo->rollBack();
    fail('Copy failed. Try again.', 500);
  }
  ok(['resume' => serialize_resume(fetch_resume($new))]);
}

case 'set-active': {
  $u  = require_role('seeker');
  $id = (int)inp('id');
  $r  = fetch_resume($id);
  if (!$r || (int)$r['user_id'] !== (int)$u['user_id']) fail('Resume not found.');
  db()->prepare('UPDATE users SET active_resume_id = ? WHERE user_id = ?')->execute([$id, (int)$u['user_id']]);
  ok();
}

/* ---- the dual-resume model: the applicant's OWN file.
        Stored outside the web root. Never parsed. Never scored. ---- */
case 'upload': {
  $u  = require_role('seeker');
  $id = (int)($_POST['resume_id'] ?? 0);
  $r  = fetch_resume($id);
  if (!$r || (int)$r['user_id'] !== (int)$u['user_id']) fail('Resume not found.');

  if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK)
    fail('That file didn\'t upload. Try again.');

  $f = $_FILES['file'];
  if ($f['size'] > MAX_UPLOAD) fail('That file is larger than 2 MB. Save it at a smaller size and try again.');

  // Trust the file's actual bytes, not the name or the browser's claim.
  $finfo = new finfo(FILEINFO_MIME_TYPE);
  $mime  = (string)$finfo->file($f['tmp_name']);
  $allowed = ALLOWED_MIME;
  if (!isset($allowed[$mime])) fail('Upload a PDF, Word document, or image (JPG or PNG).');

  if (!is_dir(UPLOAD_DIR)) @mkdir(UPLOAD_DIR, 0755, true);

  // random name: the original filename never touches the filesystem
  $stored = bin2hex(random_bytes(16)) . '.' . $allowed[$mime];
  if (!move_uploaded_file($f['tmp_name'], UPLOAD_DIR . '/' . $stored))
    fail('The file couldn\'t be stored. Check the uploads folder is writable.', 500);

  if ($r['own_file_path']) {                       // replace: bin the old one
    $old = UPLOAD_DIR . '/' . basename((string)$r['own_file_path']);
    if (is_file($old)) @unlink($old);
  }

  db()->prepare('UPDATE resumes SET own_file_name=?, own_file_mime=?, own_file_size=?, own_file_path=?, own_file_uploaded_at=NOW() WHERE resume_id=?')
      ->execute([substr(basename((string)$f['name']), 0, 200), $mime, (int)$f['size'], $stored, $id]);

  ok(['ownFile' => serialize_resume(fetch_resume($id))['ownFile']]);
}

case 'remove-file': {
  $u  = require_role('seeker');
  $id = (int)inp('id');
  $r  = fetch_resume($id);
  if (!$r || (int)$r['user_id'] !== (int)$u['user_id']) fail('Resume not found.');

  if ($r['own_file_path']) {
    $path = UPLOAD_DIR . '/' . basename((string)$r['own_file_path']);
    if (is_file($path)) @unlink($path);
  }
  db()->prepare('UPDATE resumes SET own_file_name=NULL, own_file_mime=NULL, own_file_size=NULL, own_file_path=NULL, own_file_uploaded_at=NULL WHERE resume_id=?')
      ->execute([$id]);
  ok();
}

default:
  fail('Unknown action.', 400);
}
