/* Linaw PH — routes/skills.ts
   THE SKILL DICTIONARY. The expert review asked for the admin panel to show
   "the dictionary currently listed into the catalogue, for editing, or if
   possible linking if they should be considered as one. Ex. [Git, GitHub],
   [Bookkeeping, Bookkeeper]".

   /dictionary  public: the catalogue and the admins' links, which every
                browser loads at start so its own engine (the live previews,
                the job board) scores exactly as this server does
   everything else is the company admin's (see requireCompanyAdmin)

   What a link DOES, stated once: from the moment it is saved, a resume or an
   opening using either term matches the other, everywhere. Scores are worked
   out when they are shown, so every live score follows at once. A score
   already recorded on an application is not rewritten; the recruiter's list
   marks it when the live score would now be different, as it does for any
   other change.

   The rules, mirrored word for word by the demo adapter:
     · only a catalogue skill can be linked TO
     · a term already built in, or already linked, cannot be linked again
     · nothing is linked to a term others are linked to, so a link is never a
       chain and one lookup always gives the final answer
     · linking a catalogue skill into another takes it out of the catalogue,
       so the picker never offers two names for one skill
     · a rename may change only capitals, spaces and punctuation; a different
       word is a different skill, and is added and linked instead */
import { asyncRouter } from '../lib/async-router';
import { query, queryOne, exec } from '../db';
import { ok, fail, idOf } from '../lib/http';
import { requireCompanyAdmin } from '../lib/auth';
import { SKILL_ALIASES, linkedSkills, setLinkedSkills, skillBase, skillNorm } from '../lib/engine';
import { ts } from '../lib/serializers';

const router = asyncRouter();

interface SkillRow {
  skill_id: number; skill_name: string; skill_norm: string;
  category: 'technical' | 'soft'; in_catalogue: boolean; industry: string | null;
}

const tidy = (v: unknown, n: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

/** Reads the links into the engine. Run at boot, after every edit, and once
 *  a minute, so a second server instance catches up on its own. */
export async function loadSkillLinks(): Promise<void> {
  try {
    const rows = await query<{ alias_norm: string; skill_norm: string }>(
      'SELECT a.alias_norm, s.skill_norm FROM skill_aliases a JOIN skills s ON s.skill_id = a.skill_id',
    );
    setLinkedSkills(Object.fromEntries(rows.map((r) => [r.alias_norm, r.skill_norm])));
  } catch (e: any) {
    console.warn('Could not load the skill dictionary links:', e?.message || e);
  }
}

router.post('/dictionary', async (_req, res) => {
  const cat = await query<SkillRow>(
    'SELECT skill_name, category, industry FROM skills WHERE in_catalogue ORDER BY industry NULLS LAST, skill_name',
  );
  const links = await query<{ alias_norm: string; alias_name: string; skill_name: string; skill_norm: string }>(
    `SELECT a.alias_norm, a.alias_name, s.skill_name, s.skill_norm
       FROM skill_aliases a JOIN skills s ON s.skill_id = a.skill_id ORDER BY a.alias_name`,
  );
  ok(res, {
    catalogue: cat.map((c) => ({ name: c.skill_name, category: c.category, industry: c.industry || 'Other' })),
    links: links.map((l) => ({ alias: l.alias_name, aliasNorm: l.alias_norm, target: l.skill_name, targetNorm: l.skill_norm })),
  });
});

/** Everything the admin page shows, in one payload, returned after every
 *  edit so the page never has to guess what changed. */
async function adminView() {
  const rows = await query<SkillRow & { resumes: number; postings: number }>(
    `SELECT s.*,
            (SELECT COUNT(DISTINCT rs.resume_id) FROM resume_skills rs WHERE rs.skill_id = s.skill_id) AS resumes,
            (SELECT COUNT(DISTINCT ps.posting_id) FROM posting_skills ps WHERE ps.skill_id = s.skill_id) AS postings
       FROM skills s`,
  );
  const links = await query<{ alias_norm: string; alias_name: string; skill_id: number; created_at: string; by_name: string | null }>(
    `SELECT a.alias_norm, a.alias_name, a.skill_id, a.created_at, u.full_name AS by_name
       FROM skill_aliases a LEFT JOIN users u ON u.user_id = a.created_by ORDER BY a.alias_name`,
  );
  const builtIn = new Map<string, string[]>();
  for (const [k, v] of Object.entries(SKILL_ALIASES)) builtIn.set(v, [...(builtIn.get(v) ?? []), k]);
  const byNorm = new Map(rows.map((r) => [r.skill_norm, r]));
  const linked = linkedSkills();

  const catalogue = rows.filter((r) => r.in_catalogue)
    .sort((a, b) => (a.industry || 'Other').localeCompare(b.industry || 'Other') || a.skill_name.localeCompare(b.skill_name))
    .map((r) => ({
      id: String(r.skill_id), name: r.skill_name, category: r.category, industry: r.industry || 'Other',
      resumes: Number(r.resumes), postings: Number(r.postings),
      links: links.filter((l) => l.skill_id === r.skill_id)
        .map((l) => ({ norm: l.alias_norm, name: l.alias_name, by: l.by_name, at: ts(l.created_at) })),
      builtIn: (builtIn.get(r.skill_norm) ?? []).sort(),
    }));
  // Terms people have actually used that the catalogue does not offer, the
  // natural place to find a "GitHub" that should count as "Git".
  const typed = rows.filter((r) => !r.in_catalogue && Number(r.resumes) + Number(r.postings) > 0)
    .sort((a, b) => a.skill_name.localeCompare(b.skill_name))
    .map((r) => ({
      id: String(r.skill_id), name: r.skill_name, resumes: Number(r.resumes), postings: Number(r.postings),
      linkedTo: linked[r.skill_norm] ? (byNorm.get(linked[r.skill_norm])?.skill_name ?? linked[r.skill_norm]) : null,
    }));
  const industries = [...new Set(catalogue.map((c) => c.industry))].sort((a, b) => a.localeCompare(b));
  return { catalogue, typed, industries };
}

router.post('/admin', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  ok(res, await adminView());
});

/** The display name a normalised term belongs to, for messages. */
async function nameOfNorm(norm: string): Promise<string> {
  const r = await queryOne<{ skill_name: string }>('SELECT skill_name FROM skills WHERE skill_norm = ? LIMIT 1', [norm]);
  return r?.skill_name ?? norm;
}

router.post('/add', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const name = tidy(req.body?.name, 120);
  const category = String(req.body?.category ?? '');
  const industry = tidy(req.body?.industry, 60) || 'Other';
  if (!name) return fail(res, 'Enter the skill’s name.');
  const base = skillBase(name);
  if (!base) return fail(res, 'A skill name needs at least one letter or number.');
  if (category !== 'technical' && category !== 'soft') return fail(res, 'Pick whether it is a technical or a soft skill.');
  const canon = skillNorm(name);
  if (canon !== base) return fail(res, `"${name}" already counts as ${await nameOfNorm(canon)}, so it is matched as that skill.`);

  const row = await queryOne<SkillRow>('SELECT * FROM skills WHERE skill_norm = ? LIMIT 1', [canon]);
  if (row?.in_catalogue) return fail(res, `${row.skill_name} is already in the catalogue.`);
  if (row) {
    // Someone typed it before; it joins the catalogue under the admin's spelling.
    await exec('UPDATE skills SET in_catalogue = true, category = ?, industry = ?, skill_name = ? WHERE skill_id = ?',
      [category, industry, name, row.skill_id]);
  } else {
    await exec('INSERT INTO skills (skill_name, skill_norm, category, in_catalogue, industry) VALUES (?,?,?,true,?)',
      [name, canon, category, industry]);
  }
  ok(res, await adminView());
});

router.post('/update', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const row = await queryOne<SkillRow>('SELECT * FROM skills WHERE skill_id = ? LIMIT 1', [idOf(req.body?.id)]);
  if (!row || !row.in_catalogue) return fail(res, 'Skill not found in the catalogue.');
  const name = tidy(req.body?.name, 120) || row.skill_name;
  const category = String(req.body?.category ?? row.category);
  const industry = tidy(req.body?.industry, 60) || row.industry || 'Other';
  if (category !== 'technical' && category !== 'soft') return fail(res, 'Pick whether it is a technical or a soft skill.');
  if (skillNorm(name) !== row.skill_norm)
    return fail(res, 'A rename can only change capitals, spaces and punctuation. For a different word, add it as a new skill and link the old one to it.');
  await exec('UPDATE skills SET skill_name = ?, category = ?, industry = ? WHERE skill_id = ?',
    [name, category, industry, row.skill_id]);
  ok(res, await adminView());
});

/* Out of the pickers, nothing more. Resumes and openings that already use it
   keep it and still match on it. */
router.post('/remove', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const row = await queryOne<SkillRow>('SELECT * FROM skills WHERE skill_id = ? LIMIT 1', [idOf(req.body?.id)]);
  if (!row || !row.in_catalogue) return fail(res, 'Skill not found in the catalogue.');
  await exec('UPDATE skills SET in_catalogue = false WHERE skill_id = ?', [row.skill_id]);
  ok(res, await adminView());
});

router.post('/link', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const name = tidy(req.body?.alias, 120);
  const base = skillBase(name);
  if (!base) return fail(res, 'Enter the term that should count as this skill.');
  const target = await queryOne<SkillRow>('SELECT * FROM skills WHERE skill_id = ? LIMIT 1', [idOf(req.body?.targetId)]);
  if (!target || !target.in_catalogue) return fail(res, 'Pick a skill from the catalogue to link it to.');
  if (base === target.skill_norm) return fail(res, `"${name}" is already ${target.skill_name}.`);
  if (SKILL_ALIASES[base]) return fail(res, `"${name}" is already built in as ${await nameOfNorm(SKILL_ALIASES[base])}.`);
  const linked = linkedSkills();
  if (linked[base]) return fail(res, `"${name}" is already linked to ${await nameOfNorm(linked[base])}. Unlink it first.`);
  if (Object.values(linked).includes(base))
    return fail(res, `Other terms are linked to "${name}". Unlink them first, or link them straight to ${target.skill_name}.`);

  await exec('INSERT INTO skill_aliases (alias_norm, alias_name, skill_id, created_by) VALUES (?,?,?,?)',
    [base, name, target.skill_id, u.user_id]);
  // A catalogue skill that now means another one leaves the picker.
  await exec('UPDATE skills SET in_catalogue = false WHERE skill_norm = ? AND skill_id <> ?', [base, target.skill_id]);
  await loadSkillLinks();
  ok(res, await adminView());
});

router.post('/unlink', async (req, res) => {
  const u = await requireCompanyAdmin(req, res);
  if (!u) return;
  const norm = skillBase(String(req.body?.aliasNorm ?? ''));
  const r = await exec('DELETE FROM skill_aliases WHERE alias_norm = ?', [norm]);
  if (!r.affectedRows) return fail(res, 'That link no longer exists.');
  await loadSkillLinks();
  ok(res, await adminView());
});

export default router;
