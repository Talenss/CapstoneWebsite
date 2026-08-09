/* ============================================================
   ResumeMatch PH — lib/parse-resume.ts
   ------------------------------------------------------------
   Reading a resume DOCUMENT into structured fields WITHOUT a
   language model. Rules only: section headings, regular
   expressions, date arithmetic, and a lookup against the skill
   vocabulary the scoring engine already uses.

   WHY THIS EXISTS
   The alternative path (lib/extract.ts) sends the applicant's
   document to Google's Gemini API. That works, but it costs the
   study three things: an exception to the "no artificial
   intelligence of any kind" delimitation, a disclosure that
   applicant data leaves the country, and a hard dependency on a
   network service the demonstration build cannot reach. This
   file does the same job with none of those.

   WHAT IT IS NOT
   It is not AI, and nothing here should be described as AI. It is
   pattern matching. It will read a plain, single-column resume
   well and a two-column or scanned one badly — which is precisely
   the failure this study argues that applicants are subjected to
   without being told. When it cannot read something it says so;
   it never guesses a value into a field.

   Skills are resolved through skillNorm() from lib/engine.ts, so
   a term this parser recognises is by construction a term the
   scoring engine can score. One vocabulary, one place to fix.
   ============================================================ */
import { skillNorm } from './engine';
import { query } from '../db';

export interface ParsedResume {
  title: string;
  template: 'chronological' | 'functional' | 'combination';
  design: 'classic';
  personal: {
    fullName: string; email: string; phone: string; address: string; summary: string;
    headline?: string; linkedin?: string; portfolio?: string;
  };
  education: { school: string; degree: string; level: string; year: string }[];
  experience: { position: string; company: string; months: number; description: string; bullets?: string[] }[];
  skills: string[];
  certifications: { name: string; year: string }[];
  projects?: { name: string; role?: string; description?: string; link?: string }[];
  languages?: { name: string; proficiency?: string }[];
}

/* ---------------- document → text ---------------- */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Plain text out of a PDF, page by page, with line breaks reconstructed.
 *  pdf.js gives positioned text items rather than lines, so items are grouped
 *  by their y coordinate — without that everything collapses into one line and
 *  every heading-based rule below fails. */
async function pdfToText(buffer: Buffer): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items as any[]) {
      const s = String(item.str ?? '');
      if (!s.trim()) continue;
      // transform is [a,b,c,d,e,f]; e,f are x,y. Round y so items that sit on
      // the same visual line group together despite sub-pixel differences.
      const y = Math.round((item.transform?.[5] ?? 0) / 2) * 2;
      const x = item.transform?.[4] ?? 0;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push({ x, s });
    }
    const ordered = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])                       // PDF y grows upward
      .map(([, items]) => items.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim());
    pages.push(ordered.filter(Boolean).join('\n'));
  }
  await doc.destroy();
  return pages.join('\n');
}

async function docxToText(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return value || '';
}

/* ---------------- section splitting ---------------- */

/** Canonical section a heading belongs to, or null when the line is not a
 *  heading. Matching is deliberately strict: a line only counts as a heading
 *  when it is short and contains nothing but the heading words, so a sentence
 *  that happens to mention "experience" does not start a section. */
type Section = 'summary' | 'education' | 'experience' | 'skills' | 'certifications' | 'projects' | 'languages' | 'references';

const HEADINGS: [Section, RegExp][] = [
  ['summary', /^(professional\s+)?(summary|profile|objective|about\s+me|career\s+objective)$/],
  ['education', /^(education(al)?( background| qualifications?)?|academic( background)?|schooling)$/],
  ['experience', /^(work\s+)?(experience|employment( history)?|professional\s+experience|work\s+history|career\s+history|internship(s)?)$/],
  ['skills', /^(technical\s+|core\s+|key\s+)?(skills|competenc(y|ies)|proficienc(y|ies)|expertise)$/],
  ['certifications', /^(certification(s)?|certificates?|licen[cs]es?|trainings?|seminars?)$/],
  ['projects', /^(projects?|portfolio|project\s+experience)$/],
  ['languages', /^(languages?|language\s+proficiency)$/],
  ['references', /^(references?|character\s+references?)$/],
];

function headingOf(line: string): Section | null {
  const t = line.trim().replace(/[:–—_.*#>-]+$/g, '').trim().toLowerCase();
  if (!t || t.length > 40) return null;
  for (const [sec, re] of HEADINGS) if (re.test(t)) return sec;
  return null;
}

/** Trim blank lines off both ends of a bucket and collapse runs of them to
 *  one. Blank lines are KEPT rather than filtered, because the blank line
 *  between two jobs is the single most reliable "this entry ended" signal a
 *  resume gives — dropping it here is what made two degrees read as one. */
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.trim() === '') { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** The document split into its sections, plus everything before the first
 *  heading (which is where the name and contact details live). */
function splitSections(text: string): { head: string[]; sections: Record<string, string[]> } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/g, ''));
  const head: string[] = [];
  const raw: Record<string, string[]> = {};
  let current: Section | null = null;
  for (const line of lines) {
    const h = headingOf(line);
    if (h) { current = h; raw[h] = raw[h] || []; continue; }
    if (current) raw[current].push(line);
    else head.push(line);
  }
  const sections: Record<string, string[]> = {};
  for (const k of Object.keys(raw)) sections[k] = tidy(raw[k]);
  return { head: tidy(head), sections };
}

/* ---------------- contact details ---------------- */

const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** Philippine mobile and landline shapes, plus generic international. */
const RE_PHONE = /(\+?63[\s-]?9\d{2}|09\d{2})[\s.-]?\d{3}[\s.-]?\d{4}|\(0\d{2}\)\s?\d{3}[\s.-]?\d{4}|\+\d{1,3}[\s-]?\d[\d\s.-]{7,13}\d/;
const RE_LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i;
const RE_URL = /(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|behance\.net|dribbble\.com|[a-z0-9-]+\.(?:com|ph|io|dev|me|net|org))(?:\/[^\s,;]*)?/i;

/** A plausible person's name: two to five capitalised words, no digits, and
 *  none of the words a heading or a contact fragment. Returns '' when nothing
 *  qualifies — an empty name is honest; a wrong one is not. */
function findName(head: string[]): string {
  const BAD = /\b(resume|curriculum|vitae|cv|profile|address|email|phone|mobile|contact|objective|summary)\b/i;
  for (const raw of head.slice(0, 8)) {
    const line = raw.trim().replace(/[|•·,]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line || line.length > 60 || BAD.test(line)) continue;
    if (RE_EMAIL.test(line) || /\d/.test(line)) continue;
    const words = line.split(' ').filter(Boolean);
    if (words.length < 2 || words.length > 5) continue;
    // Accept Title Case and ALL CAPS, both common on Philippine resumes.
    const ok = words.every((w) => /^[A-Z][A-Za-zÀ-ÿ'.-]*$/.test(w) || /^[A-ZÀ-Ý'.-]{2,}$/.test(w));
    if (!ok) continue;
    return words.map((w) => (w === w.toUpperCase() && w.length > 1
      ? w.charAt(0) + w.slice(1).toLowerCase() : w)).join(' ');
  }
  return '';
}

/* ---------------- dates and durations ---------------- */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const RE_RANGE = new RegExp(
  '(' + Object.keys(MONTHS).join('|') + ')?\\.?\\s*(\\d{4})'
  + '\\s*(?:-|–|—|to|until|until\\s+)\\s*'
  + '(present|current|now|(?:' + Object.keys(MONTHS).join('|') + ')?\\.?\\s*\\d{4})', 'i');

/** Whole months between two dates in a range like "Jan 2024 – Jun 2025" or
 *  "2023 - Present". Returns 0 when no range is present, because a guessed
 *  duration would feed the experience component of the score. */
function monthsFromRange(line: string, now = new Date()): number {
  const m = line.match(RE_RANGE);
  if (!m) return 0;
  const startYear = Number(m[2]);
  if (!Number.isFinite(startYear) || startYear < 1950 || startYear > now.getFullYear() + 1) return 0;
  const startMonth = m[1] ? MONTHS[m[1].toLowerCase()] : null;

  const tail = m[3].toLowerCase();
  let endMonth: number | null;
  let endYear: number;
  if (/present|current|now/.test(tail)) {
    endMonth = now.getMonth();          // "present" is a month we genuinely know
    endYear = now.getFullYear();
  } else {
    const mm = tail.match(new RegExp('(' + Object.keys(MONTHS).join('|') + ')?\\.?\\s*(\\d{4})', 'i'));
    if (!mm) return 0;
    endMonth = mm[1] ? MONTHS[mm[1].toLowerCase()] : null;
    endYear = Number(mm[2]);
  }

  /* Both months stated: count them inclusively, the way a person reads
     "Jan – Jun 2024" as six months. Either month missing: count whole years
     only. Reading "2022 to 2024" as January 2022 through December 2024 would
     hand the applicant thirty-six months of experience when they claimed
     twenty-four — an inflation of a quarter of their score, invented by this
     function rather than written by them. */
  const total = startMonth === null || endMonth === null
    ? (endYear - startYear) * 12
    : (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
  return total > 0 && total <= 600 ? total : 0;
}

/** An explicit duration the applicant wrote themselves, e.g. "6 months",
 *  "2 years". Used when no date range is present. */
function monthsFromWords(line: string): number {
  const y = line.match(/(\d{1,2})(?:\.5)?\s*(?:\+\s*)?year/i);
  const mo = line.match(/(\d{1,2})\s*(?:\+\s*)?month/i);
  const total = (y ? Number(y[1]) * 12 : 0) + (mo ? Number(mo[1]) : 0);
  return total > 0 && total <= 600 ? total : 0;
}

const findYear = (s: string): string => (s.match(/\b(19|20)\d{2}\b/) || [''])[0];

/* ---------------- education ---------------- */

/* Longest first: "associate" must not win inside "associate of science in
   bachelor…", and "high school" must be tried before "school". */
const LEVEL_PATTERNS: [string, RegExp][] = [
  ['master', /\b(master'?s?|mba|ms\.?c|m\.?a\.?\b|m\.?s\.?\b|post-?graduate|graduate\s+studies)\b/i],
  ['bachelor', /\b(bachelor'?s?|b\.?s\.?\b|b\.?a\.?\b|bsc|undergraduate|college\s+graduate|ab\b)\b/i],
  ['associate', /\b(associate'?s?|2-?year\s+course|diploma\s+in)\b/i],
  ['vocational', /\b(vocational|tesda|nc\s?(i{1,3}|iv)\b|technical\s+course|certificate\s+course)\b/i],
  ['highschool', /\b(high\s?school|senior\s+high|junior\s+high|secondary|k-?12|shs\b|hs\b)\b/i],
];

function levelOf(text: string): string {
  for (const [level, re] of LEVEL_PATTERNS) if (re.test(text)) return level;
  return 'none';
}

const SCHOOL_WORDS = /\b(university|college|institute|academy|school|polytechnic|state\s+u|campus)\b/i;

function parseEducation(lines: string[]): ParsedResume['education'] {
  const out: ParsedResume['education'] = [];
  const blocks = groupBlocks(lines);
  for (const block of blocks) {
    const joined = block.join(' ');
    const level = levelOf(joined);
    const school = block.find((l) => SCHOOL_WORDS.test(l))?.trim() ?? '';
    const degree = block.find((l) => LEVEL_PATTERNS.some(([, re]) => re.test(l)) && !SCHOOL_WORDS.test(l))?.trim()
      ?? block.find((l) => LEVEL_PATTERNS.some(([, re]) => re.test(l)))?.trim() ?? '';
    if (!school && !degree) continue;
    out.push({
      school: clean(school, 160),
      degree: clean(degree, 160),
      level,
      year: findYear(joined),
    });
    if (out.length >= 10) break;
  }
  return out;
}

/* ---------------- experience ---------------- */

/** Split a section into entries.
 *
 *  A blank line is the clearest separator and is used first. Many resumes run
 *  their entries together with no blank line, so there is a fallback: once the
 *  current entry has picked up a date range, the next ordinary line is taken
 *  as the start of the next entry. Bullets never start an entry — they belong
 *  to the job above them.
 *
 *  KNOWN LIMIT, stated rather than papered over: this assumes the date sits
 *  with or after the job title, which is the common Philippine layout. A
 *  resume that puts the date on the line ABOVE each job, with no blank lines
 *  anywhere, will be grouped one entry out of step. The consequence is a
 *  title paired with the wrong duration, so it is a real misread, not a
 *  cosmetic one. It is one of the layouts the study reports as degraded. */
function groupBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  let dated = false;
  const flush = () => { if (cur.length) blocks.push(cur); cur = []; dated = false; };

  for (const line of lines) {
    if (line.trim() === '') { flush(); continue; }
    const isBullet = /^\s*[•·*\-–▪○]/.test(line);
    const hasRange = !isBullet && RE_RANGE.test(line);
    if (!isBullet && dated && cur.length) { flush(); }
    cur.push(line);
    if (hasRange) dated = true;
  }
  flush();
  return blocks.filter((b) => b.some((l) => l.trim()));
}

const clean = (s: string, max: number): string =>
  s.replace(/^[\s•·*\-–▪○|]+/, '').replace(/\s+/g, ' ').trim().slice(0, max);

function parseExperience(lines: string[]): ParsedResume['experience'] {
  const out: ParsedResume['experience'] = [];
  for (const block of groupBlocks(lines)) {
    const bullets = block.filter((l) => /^\s*[•·*\-–▪○]/.test(l)).map((l) => clean(l, 300)).filter(Boolean).slice(0, 8);
    const plain = block.filter((l) => !/^\s*[•·*\-–▪○]/.test(l));
    const joined = block.join(' ');
    const months = monthsFromRange(joined) || monthsFromWords(joined);

    /* The first two non-bullet lines are, on the overwhelming majority of
       resumes, the job title and the employer — in one order or the other.
       Strip the date range out of them so it does not end up in the title. */
    const stripDate = (s: string) => clean(s.replace(RE_RANGE, '').replace(/[|,;]\s*$/, ''), 160);
    const first = stripDate(plain[0] ?? '');
    const second = stripDate(plain[1] ?? '');
    let position = first;
    let company = second;
    // "Position at Company" / "Position — Company" on a single line.
    const inline = (plain[0] ?? '').match(/^(.{2,80}?)\s+(?:at|@|\||—|–|,)\s+(.{2,80}?)\s*$/);
    if (inline && !second) { position = stripDate(inline[1]); company = stripDate(inline[2]); }
    if (!position && !company) continue;

    const description = clean(plain.slice(2).join(' '), 1000);
    out.push({ position, company, months, description, ...(bullets.length ? { bullets } : {}) });
    if (out.length >= 15) break;
  }
  return out;
}

/* ---------------- skills ---------------- */

/** Every skill term the system knows, as {canonical -> display name}. Read
 *  from the skills table so the parser and the engine can never disagree
 *  about what a skill is. Cached briefly for the same reason getSettings is. */
let skillCache: { at: number; byNorm: Map<string, string> } | null = null;
const SKILL_TTL_MS = 60_000;

async function skillVocabulary(): Promise<Map<string, string>> {
  if (skillCache && Date.now() - skillCache.at < SKILL_TTL_MS) return skillCache.byNorm;
  const byNorm = new Map<string, string>();
  try {
    const rows = await query<{ skill_name: string }>('SELECT skill_name FROM skills');
    for (const r of rows) byNorm.set(skillNorm(r.skill_name), r.skill_name);
  } catch {
    /* No database (or the table is missing) is not fatal — the parser simply
       falls back to the literal terms it finds in the skills section. */
  }
  skillCache = { at: Date.now(), byNorm };
  return byNorm;
}

/** Lowercase, punctuation to spaces, single-spaced. The dot, slash, plus and
 *  hash survive because they are inside real skill names — "Node.js",
 *  "HTML/CSS", "C++", "C#". A dot at the END of a word is sentence
 *  punctuation, not part of a name, so it goes: without this, a skill named
 *  as the last word of a sentence is never found. */
const flatten = (s: string) => s.toLowerCase()
  .replace(/[^a-z0-9+#./ ]+/g, ' ')
  .replace(/\.(?=\s|$)/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Catalogued terms that appear in the document as WHOLE words.
 *
 *  This is what catches a skill mentioned only inside a job description. It is
 *  also the rule most likely to over-credit an applicant, so the match is
 *  space-delimited on both sides: "Java" cannot match inside "JavaScript", and
 *  "Excel" cannot match inside "Excellent". Terms shorter than three
 *  characters are skipped entirely — "Go" and "R" appear in ordinary prose far
 *  too often to be read as a claim of skill. */
function sweepVocabulary(wholeText: string, vocab: Map<string, string>): Map<string, string> {
  const hay = ' ' + flatten(wholeText) + ' ';
  const hits = new Map<string, string>();
  for (const [n, display] of vocab) {
    const needle = flatten(display);
    if (needle.length < 3) continue;
    if (hay.includes(' ' + needle + ' ')) hits.set(n, display);
  }
  return hits;
}

/** Skills, from two sources: the skills section split on the usual
 *  separators, and a whole-document sweep for catalogued terms. */
async function parseSkills(sectionLines: string[], wholeText: string): Promise<string[]> {
  const vocab = await skillVocabulary();
  const found = new Map<string, string>();   // normalised -> display

  for (const line of sectionLines) {
    for (const piece of line.split(/[,;|•·•\t]|\s{3,}/)) {
      const term = clean(piece, 120).replace(/[.:]$/, '');
      if (!term || term.length < 2 || term.length > 60) continue;
      if (/^(and|or|etc|others?)$/i.test(term)) continue;
      const n = skillNorm(term);
      if (!n) continue;
      found.set(n, vocab.get(n) ?? term);
    }
  }

  for (const [n, display] of sweepVocabulary(wholeText, vocab)) if (!found.has(n)) found.set(n, display);

  return [...found.values()].slice(0, 30);
}

/* ---------------- the rest ---------------- */

function parseCertifications(lines: string[]): ParsedResume['certifications'] {
  return lines.map((l) => clean(l, 200)).filter((l) => l.length > 2)
    .slice(0, 10)
    .map((l) => ({ name: clean(l.replace(/\b(19|20)\d{2}\b/, ''), 200), year: findYear(l) }))
    .filter((c) => !!c.name);
}

function parseProjects(lines: string[]): NonNullable<ParsedResume['projects']> {
  return groupBlocks(lines).slice(0, 10).map((b) => {
    const name = clean(b[0] ?? '', 200);
    const description = clean(b.slice(1).join(' '), 1000);
    const link = (b.join(' ').match(RE_URL) || [''])[0];
    return { name, ...(description ? { description } : {}), ...(link ? { link } : {}) };
  }).filter((p) => !!p.name);
}

const PROFICIENCY = /\b(native|fluent|conversational|basic|intermediate|advanced|proficient|bilingual)\b/i;

function parseLanguages(lines: string[]): NonNullable<ParsedResume['languages']> {
  const out: NonNullable<ParsedResume['languages']> = [];
  for (const line of lines) {
    for (const piece of line.split(/[,;|•·]/)) {
      const t = clean(piece, 120);
      if (!t) continue;
      const prof = (t.match(PROFICIENCY) || [''])[0];
      const name = clean(t.replace(PROFICIENCY, '').replace(/[()\-–:]/g, ' '), 120);
      if (!name || name.length > 40) continue;
      out.push({ name, ...(prof ? { proficiency: prof.charAt(0).toUpperCase() + prof.slice(1).toLowerCase() } : {}) });
      if (out.length >= 10) return out;
    }
  }
  return out;
}

/** Chronological when experience carries dates, functional when there is a
 *  skills section but no dated experience, combination otherwise. */
function inferTemplate(edu: ParsedResume['education'], exp: ParsedResume['experience'], skills: string[]):
ParsedResume['template'] {
  const dated = exp.filter((e) => e.months > 0).length;
  if (dated >= 2) return 'chronological';
  if (skills.length && !dated) return 'functional';
  return 'combination';
}

/* ---------------- entry point ---------------- */

export interface ParseResult {
  status: 'ok' | 'unreadable' | 'failed';
  resume: ParsedResume | null;
  message?: string;
}

/** Document in, structured resume out — rules only, no network, no model.
 *  Never throws, for the same reason extractResume never throws: one caller
 *  is a background step on a file upload. */
export async function parseResume(buffer: Buffer, mimetype: string, fileName: string): Promise<ParseResult> {
  let text = '';
  try {
    if (mimetype === 'application/pdf') text = await pdfToText(buffer);
    else if (mimetype === DOCX_MIME) text = await docxToText(buffer);
    else if (mimetype === 'text/plain') text = buffer.toString('utf8');
    else if (mimetype === 'application/msword')
      return { status: 'unreadable', resume: null, message: 'Old .doc files cannot be read. Save it as a PDF.' };
    else
      return {
        status: 'unreadable', resume: null,
        message: 'Only PDF, Word (.docx) and plain-text files can be read without the AI service. '
          + 'A photo or scan of a resume needs the AI reader.',
      };
  } catch {
    return { status: 'unreadable', resume: null, message: "That file couldn't be opened." };
  }

  text = text.replace(/ /g, ' ').trim();
  if (text.length < 30)
    return {
      status: 'unreadable', resume: null,
      message: 'No text could be found in that file. If it is a scan or a photo, the words are an image, not text.',
    };

  const { head, sections } = splitSections(text);

  const education = parseEducation(sections.education ?? []);
  const experience = parseExperience(sections.experience ?? []);
  const skills = await parseSkills(sections.skills ?? [], text);
  const certifications = parseCertifications(sections.certifications ?? []);
  const projects = parseProjects(sections.projects ?? []);
  const languages = parseLanguages(sections.languages ?? []);

  const headText = head.join('\n');
  const linkedin = (headText.match(RE_LINKEDIN) || [''])[0];
  const portfolioMatch = headText.replace(RE_LINKEDIN, '').match(RE_URL);
  const summaryLines = sections.summary ?? [];

  /* Every education entry carries its own level. The engine takes the highest
     of them (engine.ts, seekerEdu), so nothing is collapsed here — an entry
     this parser could not classify stays 'none' and simply loses the max,
     rather than dragging a real degree down. */
  const resume: ParsedResume = {
    title: clean(fileName.replace(/\.[a-z0-9]+$/i, ''), 120) || 'Uploaded resume',
    template: inferTemplate(education, experience, skills),
    design: 'classic',
    personal: {
      fullName: findName(head),
      email: (headText.match(RE_EMAIL) || [''])[0],
      phone: (headText.match(RE_PHONE) || [''])[0].trim(),
      address: '',
      summary: clean(summaryLines.join(' '), 1000),
      ...(linkedin ? { linkedin } : {}),
      ...(portfolioMatch && !RE_EMAIL.test(portfolioMatch[0]) ? { portfolio: portfolioMatch[0] } : {}),
    },
    education,
    experience,
    skills,
    certifications,
    ...(projects.length ? { projects } : {}),
    ...(languages.length ? { languages } : {}),
  };

  /* Same rule as the AI path: a document nothing usable came out of is a
     failure, not an empty resume. An empty resume would score a confident
     zero and present it as a fact about the applicant. */
  if (!resume.personal.fullName && !skills.length && !education.length && !experience.length)
    return {
      status: 'failed', resume: null,
      message: 'Nothing readable was found in that file. If it uses columns, tables or a picture of text, '
        + 'the reader cannot follow it — which is exactly what an employer’s screening software would also struggle with.',
    };

  return { status: 'ok', resume };
}

/* Exported for tests — these are the rules the study would have to defend. */
export const __rules = {
  headingOf, splitSections, findName, monthsFromRange, monthsFromWords, levelOf, inferTemplate,
  groupBlocks, sweepVocabulary, clean,
};
