/* ============================================================
   ResumeMatch PH — lib/extract.ts
   ------------------------------------------------------------
   Turning a resume DOCUMENT into structured fields, with Gemini.

   This lived inside routes/analyze.ts, serving the opt-in "Upload
   & analyze" page. It now has a second caller: the file an
   applicant attaches to their resume is read the same way so it
   can be scored. One implementation, so the two paths can never
   disagree about what a document says.

   The model EXTRACTS. It does not score, rank or decide anything —
   that stays with the rule-based engine (skills 50 · education 25 ·
   experience 25) in lib/engine.ts. Its output is treated as
   untrusted input throughout: every field coerced, every length
   clamped, every list capped, anything unrecognised dropped.
   ============================================================ */
import { query } from '../db';
import { EDU_RANK } from './engine';
import { GEMINI_API_KEY, GEMINI_MODEL, GEMINI_BASE_URL } from '../config';

export type { AnalyzedResume };

const INLINE_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface AnalyzedResume {
  title: string;
  template: 'chronological' | 'functional' | 'combination';
  design: 'classic';
  personal: { fullName: string; email: string; phone: string; address: string; summary: string;
    headline?: string; linkedin?: string; portfolio?: string };
  education: { school: string; degree: string; level: string; year: string }[];
  experience: { position: string; company: string; months: number; description: string; bullets?: string[] }[];
  skills: string[];
  certifications: { name: string; year: string }[];
  /* Optional sections, present only when the uploaded document actually had
     them. Nothing here is scored — `months`, `level` and the flat skills list
     remain the engine's only inputs. */
  projects?: { name: string; role?: string; description?: string; link?: string }[];
  languages?: { name: string; proficiency?: string }[];
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
  const experience = (Array.isArray(raw?.experience) ? raw.experience : []).slice(0, 15).map((e: any) => {
    const bullets = (Array.isArray(e?.bullets) ? e.bullets : [])
      .map((b: any) => str(b, 300)).filter(Boolean).slice(0, 8);
    return {
      position: str(e?.position),
      company: str(e?.company),
      months: Math.max(0, Math.min(600, Math.round(Number(e?.months) || 0))),
      description: str(e?.description, 1000),
      ...(bullets.length ? { bullets } : {}),
    };
  });
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
  /* Optional sections. A section the document did not have comes back absent
     rather than as [], so the builder does not open with an empty Projects
     heading the applicant then has to delete. */
  const projects = (Array.isArray(raw?.projects) ? raw.projects : []).slice(0, 10)
    .map((x: any) => ({
      name: str(x?.name),
      ...(str(x?.role) ? { role: str(x.role) } : {}),
      ...(str(x?.description, 1000) ? { description: str(x.description, 1000) } : {}),
      ...(str(x?.link, 300) ? { link: str(x.link, 300) } : {}),
    }))
    .filter((x: any) => !!x.name);
  const languages = (Array.isArray(raw?.languages) ? raw.languages : []).slice(0, 10)
    .map((x: any) => ({
      name: str(x?.name, 120),
      ...(str(x?.proficiency, 120) ? { proficiency: str(x.proficiency, 120) } : {}),
    }))
    .filter((x: any) => !!x.name);

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
      ...(str(p?.headline, 200) ? { headline: str(p.headline, 200) } : {}),
      ...(str(p?.linkedin, 300) ? { linkedin: str(p.linkedin, 300) } : {}),
      ...(str(p?.portfolio, 300) ? { portfolio: str(p.portfolio, 300) } : {}),
    },
    education, experience, skills, certifications,
    ...(projects.length ? { projects } : {}),
    ...(languages.length ? { languages } : {}),
  };
}

async function callGemini(parts: any[]): Promise<any> {
  const url = `${GEMINI_BASE_URL}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
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


/** Builds the instruction, including the skill names this site's postings
 *  actually use so extracted skills land on the engine's canonical spellings
 *  instead of near-miss synonyms that would score nothing. */
async function buildPrompt(): Promise<string> {
  const known = await query<{ skill_name: string }>(
    `SELECT DISTINCT s.skill_name FROM posting_skills ps JOIN skills s ON s.skill_id = ps.skill_id LIMIT 150`,
  ).catch(() => [] as { skill_name: string }[]);
  const knownList = known.map((k) => k.skill_name).join(', ');
  const prompt = `You are a resume parser for a job-matching platform. Read the resume provided and extract its content.

Return ONLY a JSON object with exactly this shape (no markdown, no commentary):
{
  "title": "a short private label for this resume, e.g. 'IT — fresh graduate'",
  "personal": { "fullName": "", "email": "", "phone": "", "address": "city/province only", "summary": "2-3 sentence professional summary; write one from the resume's content if none exists", "headline": "short professional title line, e.g. 'BS Information Technology graduate'", "linkedin": "full profile URL if present", "portfolio": "full portfolio/GitHub URL if present" },
  "education": [ { "school": "", "degree": "", "level": "one of: none|highschool|vocational|associate|bachelor|master", "year": "graduation year" } ],
  "experience": [ { "position": "", "company": "", "months": 0, "description": "one sentence of what they did", "bullets": [ "each achievement bullet as written" ] } ],
  "skills": [ "individual skill names" ],
  "certifications": [ { "name": "", "year": "" } ],
  "projects": [ { "name": "", "role": "", "description": "", "link": "" } ],
  "languages": [ { "name": "", "proficiency": "e.g. Native, Fluent, Conversational" } ]
}

Rules:
- "months" is the total months worked in that role (integer; estimate from date ranges; use 0 if unknown). Internships and OJT count.
- "skills": short specific names ("JavaScript", "Customer Service"), never sentences. Include both technical and soft skills that the resume actually evidences.${knownList ? `\n- When a skill is equivalent to one of these known platform skills, use the known spelling exactly: ${knownList}` : ''}
- "bullets", "projects" and "languages": include them ONLY if the resume actually has them, otherwise return []. Never turn a paragraph into invented bullets.
- Do not extract references or any third party's contact details.
- Use "" for missing strings and [] for missing lists. Do not invent information that is not in the resume.`;
  return prompt;
}

/** Why an extraction produced nothing, in terms a person can act on.
 *    unavailable — no API key on this server; nothing was attempted
 *    unreadable  — the format cannot be read at all (old .doc, odd type)
 *    failed      — attempted and did not work: network, quota, or a scan
 *                  whose text is not legible */
export type ExtractStatus = 'ok' | 'unavailable' | 'unreadable' | 'failed';

export interface ExtractResult {
  status: ExtractStatus;
  resume: AnalyzedResume | null;
  /** Present when status is not 'ok'. Written to be shown to the applicant. */
  message?: string;
}

export const extractionConfigured = (): boolean => !!GEMINI_API_KEY;

/** Document in, structured resume out.
 *
 *  NEVER THROWS. One caller is a background step attached to a file upload,
 *  and a failure there must not take the upload down with it — the applicant
 *  still gets their file stored and sent to the recruiter. Every failure is a
 *  status with a message instead. */
export async function extractResume(buffer: Buffer, mimetype: string, fileName: string): Promise<ExtractResult> {
  if (!GEMINI_API_KEY)
    return { status: 'unavailable', resume: null, message: 'Automatic reading is not set up on this server.' };

  let part: any;
  if (INLINE_MIME.has(mimetype)) {
    part = { inlineData: { mimeType: mimetype, data: buffer.toString('base64') } };
  } else if (mimetype === DOCX_MIME) {
    try {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ buffer });
      const text = (value || '').trim();
      if (!text) return { status: 'unreadable', resume: null, message: 'That Word document appears to be empty.' };
      part = { text: `RESUME DOCUMENT TEXT:\n\n${text.slice(0, 40_000)}` };
    } catch {
      return { status: 'unreadable', resume: null, message: "That Word document couldn't be read." };
    }
  } else if (mimetype === 'application/msword') {
    return { status: 'unreadable', resume: null, message: 'Old .doc files cannot be read. Save it as a PDF.' };
  } else {
    return { status: 'unreadable', resume: null, message: 'Only PDF, Word (.docx) and image files can be read.' };
  }

  try {
    const data = await callGemini([part, { text: await buildPrompt() }]);
    const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let raw: any;
    try {
      raw = JSON.parse(jsonText);
    } catch {
      const m = jsonText.match(/\{[\s\S]*\}/);
      if (!m) return { status: 'failed', resume: null, message: 'The reading came back unusable.' };
      raw = JSON.parse(m[0]);
    }
    const resume = sanitize(raw, fileName);
    // A document nothing usable came out of is a FAILURE, not an empty
    // resume. Scoring an empty resume would produce a confident zero and
    // present it as a finding about the applicant.
    if (!resume.personal.fullName && !resume.skills.length && !resume.education.length && !resume.experience.length)
      return { status: 'failed', resume: null,
        message: 'Nothing readable was found in that file. If it is a photo or a scan, the text may not be legible to software.' };
    return { status: 'ok', resume };
  } catch (e: any) {
    if (e?.status === 429)
      return { status: 'failed', resume: null, message: 'The AI quota was reached for now. Try again in a minute.' };
    console.error('extractResume failed:', e?.message || e);
    return { status: 'failed', resume: null, message: 'The file could not be read automatically just now.' };
  }
}
