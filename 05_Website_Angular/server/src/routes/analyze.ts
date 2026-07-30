/* ============================================================
   ResumeMatch PH — routes/analyze.ts
   ------------------------------------------------------------
   The "Upload & analyze" feature (opt-in): reads a resume file the
   seeker explicitly submitted FOR ANALYSIS and returns a structured
   resume the client prefills into the builder for review.

   Nothing is saved here — the user reviews and edits the extraction
   in the builder, then saves it like any hand-built resume, and the
   rule-based engine (skills 50 · education 25 · experience 25)
   scores it exactly as always. The AI only extracts; it never ranks
   or decides anything.

   The reading itself lives in lib/extract.ts, shared with the file
   an applicant attaches to a resume, so both paths read a document
   the same way.
   ============================================================ */
import { asyncRouter } from '../lib/async-router';
import multer from 'multer';
import { ok, fail } from '../lib/http';
import { requireRole } from '../lib/auth';
import { extractResume, extractionConfigured } from '../lib/extract';
import { MAX_UPLOAD } from '../config';

const router = asyncRouter();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });

router.post('/resume', upload.single('file'), async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;

  if (!extractionConfigured())
    return fail(res, "AI analysis isn't configured on this server yet. Ask the administrator to add a GEMINI_API_KEY to the server's .env file (free at aistudio.google.com). You can still build your resume by hand in the builder.");

  const f = req.file;
  if (!f) return fail(res, "That file didn't upload. Try again.");

  const result = await extractResume(f.buffer, f.mimetype, f.originalname || 'resume');
  if (result.status !== 'ok' || !result.resume)
    return fail(res, result.message || "That file couldn't be read. Try a different file, or build your resume by hand.");

  ok(res, { resume: result.resume, provider: 'gemini' });
});

export default router;
