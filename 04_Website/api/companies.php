<?php
/* ResumeMatch PH — api/companies.php : list · get · update */
declare(strict_types=1);
require_once __DIR__ . '/_lib.php';

switch (action()) {

case 'list':
  ok(['companies' => array_map('serialize_company',
      db()->query('SELECT * FROM companies ORDER BY company_name')->fetchAll())]);

case 'get': {
  $st = db()->prepare('SELECT * FROM companies WHERE company_id = ?');
  $st->execute([(int)inp('id')]);
  $c = $st->fetch();
  if (!$c) fail('Company not found.');
  ok(['company' => serialize_company($c)]);
}

case 'update': {
  $u  = require_role('recruiter');
  $id = (int)inp('id');
  // A recruiter may only edit their OWN company.
  if ($id !== (int)$u['company_id']) fail('You can only edit your own company profile.', 403);

  db()->prepare('UPDATE companies SET company_name=?, industry=?, location=?, about=?, website=? WHERE company_id=?')
      ->execute([
        trim((string)inp('name', '')),
        trim((string)inp('industry', '')),
        trim((string)inp('location', '')),
        trim((string)inp('about', '')),
        trim((string)inp('website', '')),
        $id,
      ]);
  ok();
}

default:
  fail('Unknown action.', 400);
}
