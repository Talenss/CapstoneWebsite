<?php
/* ============================================================
   ResumeMatch PH — api/file.php
   ------------------------------------------------------------
   Serves an applicant's uploaded resume file, and ONLY to
   someone entitled to read it:
     · the applicant themselves, or
     · a recruiter at a company the resume was actually sent to.

   This is why uploads live outside the web root. A resume PDF
   must never be reachable by guessing a URL — see the privacy
   notice, and RA 10173.
   ============================================================ */
declare(strict_types=1);
require_once __DIR__ . '/_lib.php';

$u  = current_user();
$id = (int)($_GET['resume_id'] ?? 0);

if (!$u)  { http_response_code(401); exit('Not signed in.'); }
if (!$id) { http_response_code(400); exit('No file requested.'); }

$r = fetch_resume($id);
if (!$r || !$r['own_file_path']) { http_response_code(404); exit('No file.'); }

$allowed = $u['role'] === 'recruiter'
  ? recruiter_may_read_resume($u, $id)
  : (int)$r['user_id'] === (int)$u['user_id'];

if (!$allowed) { http_response_code(403); exit('You don\'t have access to that file.'); }

// basename() so a crafted DB value can never walk out of the folder
$path = UPLOAD_DIR . '/' . basename((string)$r['own_file_path']);
if (!is_file($path)) { http_response_code(404); exit('File missing from storage.'); }

$name = $r['own_file_name'] ?: 'resume';
$disp = isset($_GET['download']) ? 'attachment' : 'inline';

header_remove('Content-Type');
header('Content-Type: ' . $r['own_file_mime']);
header('Content-Length: ' . filesize($path));
header('Content-Disposition: ' . $disp . '; filename="' . preg_replace('/[^\w.\- ]/', '', $name) . '"');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: private, no-store');
readfile($path);
