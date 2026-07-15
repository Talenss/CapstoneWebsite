<?php
/* ============================================================
   ResumeMatch PH — configuration
   ------------------------------------------------------------
   The ONLY file you edit when moving between machines or hosts.
   ============================================================ */

// ---------- database ----------
// XAMPP defaults: user 'root', empty password.
// On a real host, your provider gives you these four values.
define('DB_HOST', '127.0.0.1');
define('DB_NAME', 'resumematch_ph');
define('DB_USER', 'root');
define('DB_PASS', '');
define('DB_PORT', 3306);

// ---------- uploads ----------
// Applicant resume files. Kept OUT of the web root and served only
// through file.php, which checks who's asking. A file must never be
// reachable by guessing a URL — see the privacy notice.
define('UPLOAD_DIR', __DIR__ . '/uploads');
define('MAX_UPLOAD', 2 * 1024 * 1024);            // 2 MB
define('ALLOWED_MIME', [
  'application/pdf'  => 'pdf',
  'application/msword' => 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => 'docx',
  'image/jpeg' => 'jpg',
  'image/png'  => 'png',
]);

// ---------- CORS ----------
// Leave empty when the front end is served from the same origin
// (the normal XAMPP setup). Set an origin only if you host the
// /app folder somewhere separate from /api.
define('ALLOW_ORIGIN', '');

// ---------- environment ----------
// Set to false in production: hides SQL errors from the browser.
define('DEBUG', true);
