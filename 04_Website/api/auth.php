<?php
/* ResumeMatch PH — api/auth.php
   login · register · request-access · logout · me · change-password
   · delete-account · export (RA 10173 right of access)              */
declare(strict_types=1);
require_once __DIR__ . '/_lib.php';

switch (action()) {

case 'login': {
  $email = trim((string)inp('email', ''));
  $pass  = (string)inp('password', '');
  if ($email === '' || $pass === '') fail('Enter your email and password.');

  $st = db()->prepare('SELECT * FROM users WHERE email = ? LIMIT 1');
  $st->execute([$email]);
  $u = $st->fetch();

  // Same message either way — never reveal whether an email exists.
  if (!$u || !password_verify($pass, $u['password_hash']))
    fail('That email and password don\'t match an account.');

  if ($u['role'] === 'recruiter' && !$u['verified'])
    fail('This recruiter account isn\'t active yet. Accounts are activated by the research team together with the partner company\'s HR.');

  session_regenerate_id(true);                 // no session fixation
  $_SESSION['uid'] = (int)$u['user_id'];
  db()->prepare('UPDATE users SET last_login_at = NOW() WHERE user_id = ?')->execute([(int)$u['user_id']]);

  ok(['user' => serialize_user($u)]);
}

case 'register': {
  $name  = trim((string)inp('name', ''));
  $email = trim((string)inp('email', ''));
  $pass  = (string)inp('password', '');

  if (mb_strlen($name) < 2)                     fail('Enter your full name.');
  if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Enter a valid email address.');
  if (strlen($pass) < 6)                        fail('Use a password of at least 6 characters.');

  $st = db()->prepare('SELECT 1 FROM users WHERE email = ? LIMIT 1');
  $st->execute([$email]);
  if ($st->fetchColumn()) fail('An account already uses this email. Log in instead.');

  $ins = db()->prepare('INSERT INTO users (role, full_name, email, password_hash) VALUES (?,?,?,?)');
  $ins->execute(['seeker', $name, $email, password_hash($pass, PASSWORD_BCRYPT)]);
  $id = (int)db()->lastInsertId();

  session_regenerate_id(true);
  $_SESSION['uid'] = $id;

  $st = db()->prepare('SELECT * FROM users WHERE user_id = ?');
  $st->execute([$id]);
  ok(['user' => serialize_user($st->fetch())]);
}

// Recruiters do NOT self-register. A request lands here and a human
// approves it with the partner company's HR before it becomes an account.
case 'request-access': {
  $name  = trim((string)inp('name', ''));
  $email = trim((string)inp('email', ''));
  $pos   = trim((string)inp('position', ''));
  $co    = inp('companyId');
  $note  = trim((string)inp('note', ''));

  if (mb_strlen($name) < 2)                     fail('Enter your full name.');
  if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Enter a valid email address.');
  if ($pos === '')                              fail('Enter your position.');
  if (!$co)                                     fail('Choose your partner company.');

  $st = db()->prepare('SELECT 1 FROM users WHERE email = ? LIMIT 1');
  $st->execute([$email]);
  if ($st->fetchColumn()) fail('An account already uses this email.');

  $st = db()->prepare("SELECT 1 FROM recruiter_requests WHERE email = ? AND status = 'pending' LIMIT 1");
  $st->execute([$email]);
  if ($st->fetchColumn()) fail('A request from this email is already waiting for review.');

  db()->prepare('INSERT INTO recruiter_requests (full_name, email, position_title, company_id, note) VALUES (?,?,?,?,?)')
      ->execute([$name, $email, $pos, (int)$co, $note]);
  ok();
}

case 'logout': {
  $_SESSION = [];
  if (ini_get('session.use_cookies')) {
    $p = session_get_cookie_params();
    setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'] ?? '', (bool)$p['secure'], (bool)$p['httponly']);
  }
  session_destroy();
  ok();
}

case 'me':
  ok(['user' => serialize_user(current_user())]);

case 'change-password': {
  $u   = require_user();
  $cur = (string)inp('current', '');
  $new = (string)inp('next', '');

  if (!password_verify($cur, $u['password_hash'])) fail('Your current password is incorrect.');
  if (strlen($new) < 6)                            fail('Use a password of at least 6 characters.');

  db()->prepare('UPDATE users SET password_hash = ? WHERE user_id = ?')
      ->execute([password_hash($new, PASSWORD_BCRYPT), (int)$u['user_id']]);
  ok();
}

// RA 10173, right of erasure. FK cascades take the resumes,
// applications, and skill links with it.
case 'delete-account': {
  $u = require_user();
  if (!password_verify((string)inp('password', ''), $u['password_hash'])) fail('Password is incorrect.');

  // remove the applicant's uploaded files from disk too
  $st = db()->prepare('SELECT own_file_path FROM resumes WHERE user_id = ? AND own_file_path IS NOT NULL');
  $st->execute([(int)$u['user_id']]);
  foreach ($st->fetchAll() as $row) {
    $path = UPLOAD_DIR . '/' . basename((string)$row['own_file_path']);
    if (is_file($path)) @unlink($path);
  }

  db()->prepare('UPDATE users SET active_resume_id = NULL WHERE user_id = ?')->execute([(int)$u['user_id']]);
  db()->prepare('DELETE FROM users WHERE user_id = ?')->execute([(int)$u['user_id']]);

  $_SESSION = [];
  session_destroy();
  ok();
}

// RA 10173, right of access. Everything we hold on this person.
case 'export': {
  $u = require_user();

  $st = db()->prepare('SELECT * FROM resumes WHERE user_id = ?');
  $st->execute([(int)$u['user_id']]);
  $resumes = array_map('serialize_resume', $st->fetchAll());

  $st = db()->prepare('SELECT * FROM applications WHERE seeker_id = ?');
  $st->execute([(int)$u['user_id']]);
  $apps = array_map('serialize_application', $st->fetchAll());

  ok(['data' => [
    'exportedAt'   => date('c'),
    'account'      => serialize_user($u),
    'resumes'      => $resumes,
    'applications' => $apps,
    'note'         => 'Uploaded resume files download separately from My resumes.',
  ]]);
}

default:
  fail('Unknown action.', 400);
}
