<?php
/* ResumeMatch PH — api/match.php : score · recommendations
   The three-tier output. The third tier is the point of the whole
   system: below the threshold you get REDIRECTED, not rejected.   */
declare(strict_types=1);
require_once __DIR__ . '/_lib.php';

switch (action()) {

case 'score': {
  $u = require_user();
  $r = fetch_resume((int)inp('resumeId'));
  $p = fetch_posting((int)inp('postingId'));
  if (!$r || !$p) fail('Not found.');

  if ($u['role'] === 'seeker' && (int)$r['user_id'] !== (int)$u['user_id'])
    fail('You can only score your own resumes.', 403);

  ok(rm_score(serialize_resume($r), serialize_posting($p, false)));
}

case 'recommendations': {
  $u = require_role('seeker');

  $rid = $u['active_resume_id'];
  if (!$rid) {
    $st = db()->prepare('SELECT resume_id FROM resumes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1');
    $st->execute([(int)$u['user_id']]);
    $rid = $st->fetchColumn();
  }
  if (!$rid) ok(['resume' => null, 'strong' => [], 'possible' => [], 'related' => []]);

  $r = fetch_resume((int)$rid);
  if (!$r) ok(['resume' => null, 'strong' => [], 'possible' => [], 'related' => []]);
  $resume = serialize_resume($r);

  $st = db()->prepare('SELECT posting_id FROM applications WHERE seeker_id = ?');
  $st->execute([(int)$u['user_id']]);
  $applied = array_map('strval', array_column($st->fetchAll(), 'posting_id'));

  $rows = db()->query("SELECT * FROM job_postings WHERE status='open'")->fetchAll();

  $strong = $possible = $related = [];
  foreach ($rows as $p) {
    $posting = serialize_posting($p);
    $s = rm_score($resume, $posting);
    cache_score((int)$rid, (int)$p['posting_id'], $s);

    $item = array_merge($s, [
      'posting' => $posting,
      'company' => $posting['company'] ?? null,
      'applied' => in_array((string)$p['posting_id'], $applied, true),
    ]);

    if ($s['tier'] === 'strong')        $strong[]   = $item;
    elseif ($s['tier'] === 'possible')  $possible[] = $item;
    // A related role must share at least one real skill, or it's noise
    // rather than a suggestion.
    elseif ($s['matchedSkills'])        $related[]  = $item;
  }

  $bySc = fn($a, $b) => $b['score'] <=> $a['score'];
  usort($strong, $bySc); usort($possible, $bySc); usort($related, $bySc);

  ok(['resume' => $resume, 'strong' => $strong, 'possible' => $possible, 'related' => $related]);
}

default:
  fail('Unknown action.', 400);
}
