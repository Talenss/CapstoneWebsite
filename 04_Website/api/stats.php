<?php
/* ResumeMatch PH — api/stats.php : hr (dashboard counters) */
declare(strict_types=1);
require_once __DIR__ . '/_lib.php';

if (action() !== 'hr') fail('Unknown action.', 400);

$u = require_role('recruiter');
$cid = (int)$u['company_id'];

$st = db()->prepare("SELECT
    COUNT(*) AS total,
    SUM(status='open') AS open_n
  FROM job_postings WHERE company_id = ?");
$st->execute([$cid]);
$p = $st->fetch();

$st = db()->prepare("SELECT a.status, COUNT(*) AS n
    FROM applications a
    JOIN job_postings jp ON jp.posting_id = a.posting_id
   WHERE jp.company_id = ?
   GROUP BY a.status");
$st->execute([$cid]);

$byStatus = ['submitted'=>0,'review'=>0,'shortlisted'=>0,'rejected'=>0,'hired'=>0];
$total = 0;
foreach ($st->fetchAll() as $r) {
  $byStatus[$r['status']] = (int)$r['n'];
  $total += (int)$r['n'];
}

ok(['stats' => [
  'openPostings'    => (int)$p['open_n'],
  'totalPostings'   => (int)$p['total'],
  'totalApplicants' => $total,
  'needsReview'     => $byStatus['submitted'],
  'byStatus'        => $byStatus,
]]);
