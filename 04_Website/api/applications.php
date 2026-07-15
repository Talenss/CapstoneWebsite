<?php
/* ResumeMatch PH — api/applications.php : apply · mine · ranked · set-status */
declare(strict_types=1);
require_once __DIR__ . '/_lib.php';

switch (action()) {

case 'apply': {
  $u  = require_role('seeker');
  $rid = (int)inp('resumeId');
  $pid = (int)inp('postingId');

  $r = fetch_resume($rid);
  if (!$r || (int)$r['user_id'] !== (int)$u['user_id']) fail('Choose one of your own resumes.');

  $p = fetch_posting($pid);
  if (!$p) fail('That opening no longer exists.');
  if ($p['status'] !== 'open') fail('This opening is closed.');

  $st = db()->prepare('SELECT 1 FROM applications WHERE seeker_id=? AND posting_id=? LIMIT 1');
  $st->execute([(int)$u['user_id'], $pid]);
  if ($st->fetchColumn()) fail('You already applied to this position.');

  // record the score AS IT WAS at the moment of applying
  $s = rm_score(serialize_resume($r), serialize_posting($p, false));

  db()->prepare('INSERT INTO applications (seeker_id, resume_id, posting_id, status, score_snapshot) VALUES (?,?,?,"submitted",?)')
      ->execute([(int)$u['user_id'], $rid, $pid, $s['score']]);
  $aid = (int)db()->lastInsertId();

  db()->prepare('INSERT INTO application_status_history (application_id, old_status, new_status, changed_by) VALUES (?,NULL,"submitted",?)')
      ->execute([$aid, (int)$u['user_id']]);

  cache_score($rid, $pid, $s);

  $st = db()->prepare('SELECT * FROM applications WHERE application_id = ?');
  $st->execute([$aid]);
  ok(['application' => serialize_application($st->fetch())]);
}

case 'mine': {
  $u  = require_user();
  $st = db()->prepare('SELECT * FROM applications WHERE seeker_id = ? ORDER BY applied_at DESC');
  $st->execute([(int)$u['user_id']]);

  $out = [];
  foreach ($st->fetchAll() as $a) {
    $row = serialize_application($a);
    $p = fetch_posting((int)$a['posting_id']);
    if ($p) {
      $full = serialize_posting($p);
      $row['posting'] = $full;
      $row['company'] = $full['company'] ?? null;
    }
    $r = fetch_resume((int)$a['resume_id']);
    $row['resumeTitle'] = $r ? $r['title'] : null;
    $out[] = $row;
  }
  ok(['applications' => $out]);
}

/* THE RANKED SHORTLIST.
   Sorted by score — but never FILTERED by it. Everyone who applied
   is returned. The recruiter's own filters are the only thing that
   ever hides anyone, and they can always be cleared.              */
case 'ranked': {
  $u   = require_role('recruiter');
  $pid = (int)inp('postingId');
  $p   = fetch_posting($pid);
  if (!$p || (int)$p['company_id'] !== (int)$u['company_id']) fail('Opening not found.');

  $posting = serialize_posting($p);

  $st = db()->prepare(
    'SELECT a.*, u.user_id AS s_id, u.full_name AS s_name, u.email AS s_email
       FROM applications a
       JOIN users u ON u.user_id = a.seeker_id
      WHERE a.posting_id = ?');
  $st->execute([$pid]);

  $rows = [];
  foreach ($st->fetchAll() as $a) {
    $r = fetch_resume((int)$a['resume_id']);
    if (!$r) continue;
    $resume = serialize_resume($r);
    $s = rm_score($resume, $posting);
    cache_score((int)$a['resume_id'], $pid, $s);

    $rows[] = array_merge($s, [
      'application' => serialize_application($a),
      'resume'      => $resume,
      'seeker'      => [
        'id'    => (string)$a['s_id'],
        'name'  => $a['s_name'],
        'email' => $a['s_email'],
        'role'  => 'seeker',
      ],
    ]);
  }

  usort($rows, fn($x, $y) =>
    $y['score'] <=> $x['score'] ?: $x['application']['appliedAt'] <=> $y['application']['appliedAt']);

  ok(['posting' => $posting, 'rows' => $rows]);
}

/* Every status change is a HUMAN decision, and it is recorded as one. */
case 'set-status': {
  $u      = require_role('recruiter');
  $aid    = (int)inp('id');
  $status = (string)inp('status');

  if (!in_array($status, ['submitted','review','shortlisted','rejected','hired'], true))
    fail('Unknown status.');

  $st = db()->prepare(
    'SELECT a.*, p.company_id
       FROM applications a
       JOIN job_postings p ON p.posting_id = a.posting_id
      WHERE a.application_id = ?');
  $st->execute([$aid]);
  $a = $st->fetch();
  if (!$a || (int)$a['company_id'] !== (int)$u['company_id']) fail('Application not found.');

  db()->prepare('UPDATE applications SET status = ? WHERE application_id = ?')->execute([$status, $aid]);
  db()->prepare('INSERT INTO application_status_history (application_id, old_status, new_status, changed_by) VALUES (?,?,?,?)')
      ->execute([$aid, $a['status'], $status, (int)$u['user_id']]);

  $st = db()->prepare('SELECT * FROM applications WHERE application_id = ?');
  $st->execute([$aid]);
  ok(['application' => serialize_application($st->fetch())]);
}

default:
  fail('Unknown action.', 400);
}
