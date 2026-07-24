/* ============================================================
   ResumeMatch PH — routes/analyze.ts
   ------------------------------------------------------------
   The "Upload & analyze" feature (opt-in): reads a resume file the
   seeker explicitly submitted FOR ANALYSIS, extracts its content
   with Google's Gemini API, and returns a structured resume the
   client prefills into the builder for the user to review.

   Nothing is saved here — the user reviews and edits the extraction
   in the builder, then saves it like any hand-built resume, and the
   existing rule-based engine (skills 50 · education 25 · experience
   25) scores it exactly as always. The AI only extracts; it never
   ranks or decides anything.

   This is separate from the dual-resume "own file" attachment,
   which remains never-parsed and visible to recruiters only.
   ============================================================ */
import { Router } from 'express';
import multer from 'multer';
import { query } from '../db';
import { ok, fail } from '../lib/http';
import { requireRole } from '../lib/auth';
import { EDU_RANK } from '../lib/engine';
import { GEMINI_API_KEY, GEMINI_MODEL, MAX_UPLOAD } from '../config';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });

// Mime types Gemini can read directly as inline document/image data.
const INLINE_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface AnalyzedResume {
  title: string;
  template: 'chronological' | 'functional' | 'combination';
  design: 'classic';
  personal: { fullName: string; email: string; phone: string; address: string; summary: string };
  education: { school: string; degree: string; level: string; year: string }[];
  experience: { position: string; company: string; months: number; description: string }[];
  skills: string[];
  certifications: { name: string; year: string }[];
}

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The model's output is untrusted — coerce every field into the exact
 *  shape resumes.save expects, drop anything extra, clamp lengths. */
function sanitize(raw: any, fileName: string): AnalyzedResume {
  const levels = Object.keys(EDU_RANK);
  const education = (Array.isArray(raw?.education) ? raw.education : []).slice(0, 10).map((e: any) => ({
    school: str(e?.school),
    degree: str(e?.degree),
    level: levels.includes(e?.level) ? e.level : 'bachelor',
    year: str(e?.year, 10),
  }));
  const experience = (Array.isArray(raw?.experience) ? raw.experience : []).slice(0, 15).map((e: any) => ({
    position: str(e?.position),
    company: str(e?.company),
    months: Math.max(0, Math.min(600, Math.round(Number(e?.months) || 0))),
    description: str(e?.description, 1000),
  }));
  const seen = new Set<string>();
  const skills = (Array.isArray(raw?.skills) ? raw.skills : [])
    .map((s: any) => str(s, 120))
    .filter((s: string) => {
      const k = s.toLowerCase();
      if (!s || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 30);
  const certifications = (Array.isArray(raw?.certifications) ? raw.certifications : []).slice(0, 10).map((c: any) => ({
    name: str(c?.name),
    year: str(c?.year, 10),
  }));
  const p = raw?.personal ?? {};
  return {
    title: str(raw?.title) || fileName.replace(/\.[^.]+$/, '') || 'Uploaded resume',
    template: 'chronological',
    design: 'classic',
    personal: {
      fullName: str(p?.fullName, 120),
      email: str(p?.email, 160),
      phone: str(p?.phone, 40),
      address: str(p?.address, 200),
      summary: str(p?.summary, 2000),
    },
    education, experience, skills, certifications,
  };
}

async function callGemini(parts: any[]): Promise<any> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err: any = new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

router.post('/resume', upload.single('file'), async (req, res) => {
  const u = await requireRole(req, res, 'seeker');
  if (!u) return;

  if (!GEMINI_API_KEY)
    return fail(res, "AI analysis isn't configured on this server yet. Ask the administrator to add a GEMINI_API_KEY to the server's .env file (free at aistudio.google.com). You can still build your resume by hand in the builder.");

  const f = req.file;
  if (!f) return fail(res, "That file didn't upload. Try again.");

  // Build the model input: PDFs and images go in directly; Word .docx is
  // converted to text first; legacy .doc can't be read — ask for a PDF.
  let contentPart: any;
  if (INLINE_MIME.has(f.mimetype)) {
    contentPart = { inlineData: { mimeType: f.mimetype, data: f.buffer.toString('base64') } };
  } else if (f.mimetype === DOCX_MIME) {
    try {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: f.buffer });
      const text = (value || '').trim();
      if (!text) return fail(res, "That Word document appears to be empty or unreadable. Try saving it as a PDF and uploading again.");
      contentPart = { text: `RESUME DOCUMENT TEXT:\n\n${text.slice(0, 40_000)}` };
    } catch {
      return fail(res, "That Word document couldn't be read. Try saving it as a PDF and uploading again.");
    }
  } else if (f.mimetype === 'application/msword') {
    return fail(res, 'Old .doc files can’t be analyzed. Save it as PDF or .docx and try again.');
  } else {
    return fail(res, 'Upload a PDF, Word document (.docx), or image (JPG or PNG).');
  }

  // Give the model the skills already used across this site's postings, so
  // extracted skills line up with the engine's canonical skill rows.
  const known = await query<{ skill_name: string }>(
    `SELECT DISTINCT s.skill_name FROM posting_skills ps JOIN skills s ON s.skill_id = ps.skill_id LIMIT 150`,
  ).catch(() => [] as { skill_name: string }[]);
  const knownList = known.map((k) => k.skill_name).join(', ');

  const prompt = `You are a resume parser for a job-matching platform. Read the resume provided and extract its content.

Return ONLY a JSON object with exactly this shape (no markdown, no commentary):
{
  "title": "a short private label for this resume, e.g. 'IT — fresh graduate'",
  "personal": { "fullName": "", "email": "", "phone": "", "address": "city/province only", "summary": "2-3 sentence professional summary; write one from the resume's content if none exists" },
  "education": [ { "school": "", "degree": "", "level": "one of: none|highschool|vocational|associate|bachelor|master", "year": "graduation year" } ],
  "experience": [ { "position": "", "company": "", "months": 0, "description": "one sentence of what they did" } ],
  "skills": [ "individual skill names" ],
  "certifications": [ { "name": "", "year": "" } ]
}

Rules:
- "months" is the total months worked in that role (integer; estimate from date ranges; use 0 if unknown). Internships and OJT count.
- "skills": short specific names ("JavaScript", "Customer Service"), never sentences. Include both technical and soft skills that the resume actually evidences.${knownList ? `\n- When a skill is equivalent to one of these known platform skills, use the known spelling exactly: ${knownList}` : ''}
- Use "" for missing strings and [] for missing lists. Do not invent information that is not in the resume.`;

  try {
    const data = await callGemini([contentPart, { text: prompt }]);
    const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let raw: any;
    try {
      raw = JSON.parse(jsonText);
    } catch {
      const m = jsonText.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Model returned no JSON');
      raw = JSON.parse(m[0]);
    }
    const resume = sanitize(raw, f.originalname || 'resume');
    if (!resume.personal.fullName && !resume.skills.length && !resume.education.length && !resume.experience.length)
      return fail(res, "The analysis couldn't find resume content in that file. Check it's a readable resume and try again — or build it by hand in the builder.");
    ok(res, { resume, provider: 'gemini' });
  } catch (e: any) {
    console.error('analyze/resume failed:', e?.message || e);
    if (e?.status === 429)
      return fail(res, 'The free AI quota was reached for now. Wait a minute and try again.');
    if (e?.status === 400 || e?.status === 403)
      return fail(res, 'The AI service rejected the request — check that the GEMINI_API_KEY in the server’s .env is valid.');
    if (e?.name === 'AbortError')
      return fail(res, 'The analysis took too long and was cancelled. Try again, or use a smaller file.');
    return fail(res, "The analysis failed. Try again in a moment — or build your resume by hand in the builder.");
  }
});

export default router;
