/* ============================================================
   Linaw PH — lib/extract.ts
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
import { geminiApiKey, GEMINI_MODEL, geminiBaseUrl, resumeExtractorMode } from '../config';
import { parseResume } from './parse-resume';

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
    // The model is untrusted: anything it returns that is not a known level
    // means unknown, and unknown must claim nothing rather than a degree.
    level: levels.includes(e?.level) ? e.level : 'none',
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
  /* The rule-based reader infers a template from the document's shape and the
     model is never asked for one, so an absent or unrecognised value means
     chronological — the layout the print sheet was designed around. */
  const TEMPLATES = ['chronological', 'functional', 'combination'] as const;
  return {
    title: str(raw?.title) || fileName.replace(/\.[^.]+$/, '') || 'Uploaded resume',
    template: TEMPLATES.includes(raw?.template) ? raw.template : 'chronological',
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

/* The structure the reply must have. Mirrors the shape spelled out in
   buildPrompt(); the prompt still carries the RULES (extract only, known skill
   spellings, no invented bullets), which a schema cannot express. Keep the two
   in step — a field added to one and not the other is silently dropped.

   Types are the API's own enum spelling (OBJECT/ARRAY/STRING/INTEGER), not
   JSON Schema's lowercase. */
const S = (properties: any) => ({ type: 'OBJECT', properties });
const STR = { type: 'STRING' };
const STR_LIST = { type: 'ARRAY', items: STR };

const RESPONSE_SCHEMA = S({
  title: STR,
  personal: S({
    fullName: STR, email: STR, phone: STR, address: STR,
    summary: STR, headline: STR, linkedin: STR, portfolio: STR,
  }),
  education: { type: 'ARRAY', items: S({ school: STR, degree: STR, level: STR, year: STR }) },
  experience: {
    type: 'ARRAY',
    items: S({
      position: STR, company: STR, months: { type: 'INTEGER' },
      description: STR, bullets: STR_LIST,
    }),
  },
  skills: STR_LIST,
  certifications: { type: 'ARRAY', items: S({ name: STR, year: STR }) },
  projects: { type: 'ARRAY', items: S({ name: STR, role: STR, description: STR, link: STR }) },
  languages: { type: 'ARRAY', items: S({ name: STR, proficiency: STR }) },
});

async function callGemini(parts: any[]): Promise<any> {
  const url = `${geminiBaseUrl()}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey())}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
          /* DECLARE THE SHAPE, do not just ask for it in the prompt.
             responseMimeType alone promises JSON and does not deliver it: on
             gemini-3.5-flash the reply came back repeatedly with its final
             closing brace missing — reported as finishReason STOP, with a
             complete HTTP body, so it does not look truncated from the outside
             and the failure surfaces only as a parse error. Raising
             maxOutputTokens made no difference. With the schema declared the
             same call parsed on every attempt and returned byte-identical
             output, which is also what a study needs to be reproducible. */
          responseSchema: RESPONSE_SCHEMA,
          /* A ceiling, not a target. A well-behaved extraction of a long resume
             lands near 300-800 tokens, so this never binds in normal use — it
             exists because a degenerate reply already happened once here and
             cost 65,520 tokens in a single call, which is a whole day of
             free-tier quota spent on one upload. Better to fail one file and
             fall through to the rule-based reader than to spend the quota every
             other applicant depends on. */
          maxOutputTokens: 4096,
          /* Thinking off. Extraction copies text out of a document, it does not
             reason, so the deliberation tokens buy nothing and cost latency on
             a page an applicant is waiting on. */
          thinkingConfig: { thinkingBudget: 0 },
        },
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
  /* NO JSON TEMPLATE HERE. The shape is declared to the API as RESPONSE_SCHEMA
     instead, and stating it twice is not belt-and-braces — it is actively
     harmful. With both present, gemini-3.5-flash ran away: 65,520 output
     tokens, 164 seconds, finishReason MAX_TOKENS, and a quarter-megabyte reply
     that of course did not parse. One such call exhausts a day of free-tier
     quota. The same prompt with the template removed answers in about two
     seconds and 310 tokens.

     What the template DID carry, and the schema cannot, is the per-field
     guidance — the address granularity, the level vocabulary, which fields are
     copied verbatim. That is why those moved into the rules below rather than
     being deleted with it. */
  const prompt = `You are a resume parser for a job-matching platform. Read the resume provided and extract its content into the required structure.

Rules:
- "title": a short private label for this resume, e.g. "IT — fresh graduate".
- "personal.address": city/province only.
- "personal.summary": the resume's own summary/profile/objective section, copied as written; "" if it has none.
- "personal.headline": the professional title line the resume itself states under the name; "" if it has none.
- "personal.linkedin" / "personal.portfolio": the full URL if present.
- "education.level": exactly one of none|highschool|vocational|associate|bachelor|master.
- "education.year": the graduation year.
- "experience.description": the role's own description text as written; "" if the entry has only bullets.
- "experience.bullets": each achievement bullet as written.
- "certifications": the name and year as printed.
- "projects": name, role, description and link as printed.
- "languages": the language name and the proficiency as stated, e.g. Native, Fluent, Conversational.
- "months" is the total months worked in that role (integer; estimate from date ranges; use 0 if unknown). Internships and OJT count.
- "skills": short specific names ("JavaScript", "Customer Service"), never sentences. Include both technical and soft skills that the resume actually evidences.${knownList ? `\n- When a skill is equivalent to one of these known platform skills, use the known spelling exactly: ${knownList}` : ''}
- "bullets", "projects" and "languages": include them ONLY if the resume actually has them, otherwise return []. Never turn a paragraph into invented bullets.
- Do not extract references or any third party's contact details.
- Use "" for missing strings and [] for missing lists. Do not invent information that is not in the resume.
- EXTRACT ONLY. Do not write, compose, summarise or rephrase any prose. Every string you return must be text the resume itself contains, copied as written. Where the resume has no text for a field, return "" — an empty field is correct and will be filled in by the applicant.`;
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
  /** WHICH reader produced this result, which is not always the one that was
   *  tried first — see the fallback in extractResume. The study compares the
   *  two readers, so the answer has to travel with the result rather than be
   *  inferred from configuration afterwards. */
  reader?: 'rules' | 'gemini';
  /* How the answer was arrived at, for the study's own counting: whether the
     rules reader was enough, and when it was not, whether the model helped. */
  path?: ExtractPath;
  /** Which fields were empty when escalation was triggered. */
  escalatedBecause?: string[];
}

/** The four fields a usable reading produces, and how many came back empty.
 *
 *  This exists because "did it fail?" is not the question. The rules reader
 *  reports 'ok' for a document whose headings it did not recognise — it found
 *  a name, found no section it understood, and returned a resume that is
 *  technically valid and practically empty. A status of 'ok' with nothing in
 *  it is worse than a failure, because a failure at least says so.
 *
 *  Two of four empty is the line. One empty field is ordinary: plenty of real
 *  applicants have no certifications, and a fresh graduate may genuinely have
 *  zero months. Two is a document the reader did not understand. */
export function thinReading(r: AnalyzedResume | null): { thin: boolean; empty: string[] } {
  if (!r) return { thin: true, empty: ['name', 'skills', 'education', 'experience'] };
  const empty: string[] = [];
  if (!r.personal?.fullName) empty.push('name');
  if (!r.skills?.length) empty.push('skills');
  if (!r.education?.length) empty.push('education');
  if (!r.experience?.reduce((t, e) => t + (Number(e.months) || 0), 0)) empty.push('experience');
  return { thin: empty.length >= 2, empty };
}

/** Which reader is TRIED FIRST. Resolves 'auto' to a concrete choice so
 *  callers, tests and the metrics export all agree on what was attempted.
 *
 *  This is also the value the consent notice is written from, and that is the
 *  reason it reports the attempt rather than the outcome: if Gemini is going to
 *  be tried, the applicant's document may reach Google, and they have to be
 *  told that BEFORE they agree — whether or not the attempt later succeeds. */
export function activeExtractor(): 'rules' | 'gemini' {
  const mode = resumeExtractorMode();
  if (mode === 'rules') return 'rules';
  if (mode === 'gemini') return 'gemini';
  /* 'escalate' tries the rules reader first, so that is what is ATTEMPTED —
     and the consent notice is written from this value. Reporting 'gemini'
     here would warn every applicant that their document may reach Google
     when most documents never will; reporting 'rules' and then escalating
     would be the same promise broken the other way. The notice therefore
     says the model MAY be called, and this returns the reader that runs
     first. See the consent copy in the analyze route. */
  if (mode === 'escalate') return 'rules';
  return geminiApiKey() ? 'gemini' : 'rules';
}

/** True when the rules reader may hand a document it could not read on to
 *  the model. Distinct from fallbackAllowed(), which is the other direction:
 *  a Gemini failure caught by the rules reader. */
const escalationAllowed = (): boolean => resumeExtractorMode() === 'escalate' && !!geminiApiKey();

/** True when a Gemini failure should be caught by the rule-based reader.
 *
 *  Only in 'auto'. Pinning 'gemini' means the operator asked for that reader
 *  specifically, and silently answering with a different one would hide the
 *  very failure they pinned it to observe — which is exactly what the
 *  extraction test suite asserts, so this is load-bearing rather than tidy. */
const fallbackAllowed = (): boolean => resumeExtractorMode() === 'auto';

/** True when SOME reader can run. The rule-based one needs nothing, so this is
 *  only false where the operator has pinned 'gemini' and supplied no key. */
export const extractionConfigured = (): boolean =>
  activeExtractor() === 'rules' || !!geminiApiKey();

/** Reported alongside a result so the study can count how often escalation
 *  actually fired, rather than inferring it from configuration afterwards. */
export type ExtractPath = 'rules' | 'gemini' | 'rules-then-gemini' | 'rules-kept';

/** The rule-based reader, wrapped so its output goes through the SAME
 *  sanitize() the model's output does — same clamped shape, so nothing
 *  downstream can tell which reader answered. */
async function runRulesOn(buffer: Buffer, mimetype: string, fileName: string): Promise<ExtractResult> {
  const r = await parseResume(buffer, mimetype, fileName);
  return {
    status: r.status,
    resume: r.resume ? sanitize(r.resume, fileName) : null,
    ...(r.message ? { message: r.message } : {}),
    reader: 'rules',
  };
}

/** The model path, on its own so BOTH entry points can reach it: the plain
 *  'gemini'/'auto' modes below, and the escalation in 'escalate' mode above.
 *  Before this was extracted the model path lived inside extractResume and
 *  escalation had nothing to call. */
async function runGemini(buffer: Buffer, mimetype: string, fileName: string): Promise<ExtractResult> {
  const runRules = () => runRulesOn(buffer, mimetype, fileName);

  if (!geminiApiKey()) {
    /* Unreachable in 'auto' — activeExtractor would have chosen rules. This is
       the operator pinning 'gemini' and forgetting the key, and it is reported
       rather than quietly answered by the other reader. */
    return { status: 'unavailable', resume: null, message: 'Automatic reading is not set up on this server.' };
  }

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
      if (fallbackAllowed()) return runRules();
      return { status: 'unreadable', resume: null, message: "That Word document couldn't be read." };
    }
  } else if (mimetype === 'application/msword') {
    return { status: 'unreadable', resume: null, message: 'Old .doc files cannot be read. Save it as a PDF.' };
  } else {
    /* A type the GEMINI branch cannot package — plain text is the live case.
       The rule-based reader handles it, so in auto mode this is a reason to use
       the other reader rather than to refuse the file. Refusing here would mean
       a .txt résumé was rejected by a system that can read .txt. */
    if (fallbackAllowed()) return runRules();
    return { status: 'unreadable', resume: null, message: 'Only PDF, Word (.docx) and image files can be read.' };
  }

  /* From here the document is handed to Google. Every way this can go wrong —
     a network failure, an exhausted quota, a reply that is not JSON, a reply
     that yields nothing usable — falls back to the rule-based reader in 'auto'
     rather than telling the applicant the feature is broken. Reading their
     document badly is better than not reading it at all, and the alternative
     is a dead page in the middle of a demonstration. */
  try {
    const data = await callGemini([part, { text: await buildPrompt() }]);
    const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let raw: any;
    try {
      raw = JSON.parse(jsonText);
    } catch {
      /* Salvage: the reply is usually valid JSON wrapped in chatter. The greedy
         match takes the outermost braces, which is right for that case.

         It is WRONG for a truncated reply, and that is the common failure: the
         last `}` is then some inner object's, so the match ends mid-structure
         and parsing it throws a second time — with a confusing offset pointing
         into the middle of the document rather than at its cut-off end. That
         throw used to escape to the outer catch, which in pinned-gemini mode
         reported a JSON position as if it were the fault. Guarded here so an
         unsalvageable reply takes the same route as no match at all. */
      const m = jsonText.match(/\{[\s\S]*\}/);
      try {
        if (!m) throw new Error('no JSON object in reply');
        raw = JSON.parse(m[0]);
      } catch {
        if (fallbackAllowed()) return runRules();
        return { status: 'failed', resume: null, message: 'The reading came back unusable.' };
      }
    }
    const resume = sanitize(raw, fileName);
    // A document nothing usable came out of is a FAILURE, not an empty
    // resume. Scoring an empty resume would produce a confident zero and
    // present it as a finding about the applicant.
    if (!resume.personal.fullName && !resume.skills.length && !resume.education.length && !resume.experience.length) {
      if (fallbackAllowed()) return runRules();
      return { status: 'failed', resume: null,
        message: 'Nothing readable was found in that file. If it is a photo or a scan, the text may not be legible to software.' };
    }
    return { status: 'ok', resume, reader: 'gemini' };
  } catch (e: any) {
    console.error('extractResume: gemini failed:', e?.message || e);
    if (fallbackAllowed()) return runRules();
    if (e?.status === 429)
      return { status: 'failed', resume: null, message: 'The AI quota was reached for now. Try again in a minute.' };
    return { status: 'failed', resume: null, message: 'The file could not be read automatically just now.' };
  }
}

/** Document in, structured resume out.
 *
 *  NEVER THROWS. One caller is a background step attached to a file upload,
 *  and a failure there must not take the upload down with it — the applicant
 *  still gets their file stored and sent to the recruiter. Every failure is a
 *  status with a message instead. */
export async function extractResume(buffer: Buffer, mimetype: string, fileName: string): Promise<ExtractResult> {
  const runRules = () => runRulesOn(buffer, mimetype, fileName);

  if (activeExtractor() === 'rules') {
    const first = await runRules();

    /* ESCALATION. The rules reader ran and cost nothing. Spend a request only
       on the documents it could not read — the two-column layouts, the scans,
       the resumes whose headings it has never seen. A plain single-column
       resume, which is most of them, never reaches Google at all.

       Note this is checked on a reading that says 'ok'. A document the rules
       reader reported as FAILED is handled by the same branch, because
       thinReading(null) is thin by definition. */
    if (!escalationAllowed()) return first;
    const { thin, empty } = thinReading(first.resume);
    if (!thin) return { ...first, path: 'rules-kept' };

    const escalated = await runGemini(buffer, mimetype, fileName);
    /* If the model did no better, keep the rules reading rather than the
       model's. Two readers failing is not a reason to prefer the one that
       cost money, and the applicant is better served by the reader whose
       behaviour we can explain. */
    if (escalated.status !== 'ok' || thinReading(escalated.resume).thin) {
      return { ...first, path: 'rules-kept', escalatedBecause: empty };
    }
    return { ...escalated, path: 'rules-then-gemini', escalatedBecause: empty };
  }

  const g = await runGemini(buffer, mimetype, fileName);
  return { path: g.reader === 'rules' ? 'rules' : 'gemini', ...g };
}
