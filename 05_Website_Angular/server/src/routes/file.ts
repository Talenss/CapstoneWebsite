/* ============================================================
   Linaw PH — routes/file.ts
   ------------------------------------------------------------
   Serves an applicant's uploaded resume file, and ONLY to
   someone entitled to read it:
     · the applicant themselves, or
     · a recruiter at a company the resume was actually sent to.

   Port of api/file.php. Uploads live outside the web root — a
   resume file must never be reachable by guessing a URL.
   ============================================================ */
import { asyncRouter } from '../lib/async-router';
import { currentUser } from '../lib/auth';
import { fetchResume, recruiterMayReadResume } from '../lib/serializers';
import { getFile } from '../lib/storage';

const router = asyncRouter();

router.get('/', async (req, res) => {
  const u = await currentUser(req);
  const id = Number(req.query.resume_id ?? 0);

  if (!u) return res.status(401).send('Not signed in.');
  if (!id) return res.status(400).send('No file requested.');

  const r = await fetchResume(id);
  if (!r || !r.own_file_path) return res.status(404).send('No file.');

  const allowed = u.role === 'recruiter' ? await recruiterMayReadResume(u, id) : r.user_id === u.user_id;
  if (!allowed) return res.status(403).send("You don't have access to that file.");

  /* Read the whole object rather than streaming it. Uploads are capped at
     2 MB and the alternative — handing the browser a signed Supabase URL —
     would put the file on an origin this route cannot police, which is the
     one thing the access checks above exist to prevent. */
  let body: Buffer | null;
  try {
    body = await getFile(r.own_file_path); // storage basenames the key
  } catch (e: any) {
    console.error('File read failed:', e?.message || e);
    return res.status(502).send('That file could not be read right now.');
  }
  if (!body) return res.status(404).send('File missing from storage.');

  const name = r.own_file_name || 'resume';
  const disp = req.query.download !== undefined ? 'attachment' : 'inline';
  const safeName = name.replace(/[^\w.\- ]/g, '');

  res.setHeader('Content-Type', r.own_file_mime || 'application/octet-stream');
  res.setHeader('Content-Length', body.length);
  res.setHeader('Content-Disposition', `${disp}; filename="${safeName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(body);
});

export default router;
