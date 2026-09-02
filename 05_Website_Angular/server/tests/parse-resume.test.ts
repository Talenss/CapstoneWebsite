/* ============================================================
   The rule-based resume reader (lib/parse-resume.ts).

   These are the rules the study has to be able to defend, so each
   one is tested on its own as well as through the whole parser.
   The accuracy test at the end is the one that matters: it reads a
   realistic resume and asserts the fields the SCORING ENGINE
   actually consumes — skills, education level, months — because
   those are the only outputs that can change an applicant's score.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResume, __rules } from '../src/lib/parse-resume';
import { thinReading } from '../src/lib/extract';
import { EDU_RANK } from '../src/lib/engine';
import fs from 'node:fs';
import path from 'node:path';

const { headingOf, headingTail, undoubleSpace, splitSections, findName, monthsFromRange, monthsFromWords, levelOf, groupBlocks, sweepVocabulary } = __rules;

const txt = (s: string) => Buffer.from(s, 'utf8');
const TEXT = 'text/plain';

/* ---------------- headings ---------------- */

test('section headings are recognised in the forms Philippine resumes use', () => {
  assert.equal(headingOf('EDUCATION'), 'education');
  assert.equal(headingOf('Educational Background'), 'education');
  assert.equal(headingOf('Work Experience'), 'experience');
  assert.equal(headingOf('EMPLOYMENT HISTORY'), 'experience');
  assert.equal(headingOf('Skills:'), 'skills');
  assert.equal(headingOf('Technical Skills'), 'skills');
  assert.equal(headingOf('Certifications'), 'certifications');
  assert.equal(headingOf('Seminars'), 'certifications');
  assert.equal(headingOf('Character References'), 'references');
});

test('the section names Philippine fresh-graduate resumes actually use', () => {
  // This study's population is fresh graduates, whose entire experience
  // section is OJT or practicum. Reading those as "no experience" zeroed a
  // quarter of the score for exactly the people the system exists to help.
  assert.equal(headingOf('OJT'), 'experience');
  assert.equal(headingOf('On-the-Job Training'), 'experience');
  assert.equal(headingOf('PRACTICUM'), 'experience');
  assert.equal(headingOf('Work Immersion'), 'experience');
  assert.equal(headingOf('EDUCATIONAL ATTAINMENT'), 'education');
  assert.equal(headingOf('Tertiary Education'), 'education');
  assert.equal(headingOf('Skills and Abilities'), 'skills');
  assert.equal(headingOf('QUALIFICATIONS'), 'skills');
  assert.equal(headingOf('Awards and Recognition'), 'certifications');
  assert.equal(headingOf('Seminars Attended'), 'certifications');
  assert.equal(headingOf('Capstone Project'), 'projects');
});

test('a heading survives the ornament a template puts in front of it', () => {
  assert.equal(headingOf('1. EDUCATION'), 'education');
  assert.equal(headingOf('2) Work Experience'), 'experience');
  assert.equal(headingOf('\u25aa SKILLS'), 'skills');
  assert.equal(headingOf('> Projects'), 'projects');
});

test('a heading with its content on the same line is still a heading', () => {
  // "SKILLS: HTML, CSS" is one line doing two jobs, and compact resumes
  // written to fit one page do this constantly.
  assert.equal(headingOf('SKILLS: HTML, CSS, JavaScript'), 'skills');
  assert.equal(headingOf('Education: BS Information Technology'), 'education');
  // But a sentence that merely contains a colon is not a heading.
  assert.equal(headingOf('My objective is the following: to grow as a developer'), null);
});

test('letter-spaced headings are read, and real short words are not', () => {
  assert.equal(headingOf('E D U C A T I O N'), 'education');
  assert.equal(headingOf('S K I L L S'), 'skills');
  // Only collapse when EVERY token is one letter, so this stays untouched.
  assert.equal(headingOf('R and D'), null);
});

test('content sharing a line with its heading is kept, not dropped', () => {
  // Found by the reader-comparison harness: "SKILLS: HTML, CSS" was matched
  // as a heading and the skills after the colon were thrown away, so a
  // compact one-page resume scored zero on half of every posting.
  assert.equal(headingTail('SKILLS: HTML/CSS, JavaScript, Git'), 'HTML/CSS, JavaScript, Git');
  assert.equal(headingTail('SKILLS'), '');
  const { sections } = splitSections('SKILLS: HTML/CSS, JavaScript\nGit\n');
  assert.deepEqual(sections.skills, ['HTML/CSS, JavaScript', 'Git']);
});

test('a letter-spaced heading of two words stays two words', () => {
  // Also found by the harness: every token is a single letter, so the naive
  // collapse produced "workexperience", which matches nothing — and the whole
  // experience section was read as header text.
  assert.equal(headingOf('W O R K   E X P E R I E N C E'), 'experience');
  assert.equal(headingOf('E D U C A T I O N'), 'education');
});

test('a uniformly double-spaced document is un-doubled before grouping', () => {
  // mammoth.extractRawText joins .docx paragraphs with a blank line, so every
  // real Word document arrives double-spaced. Blank lines are how one job is
  // told from the next, so this shattered every entry into single lines: a
  // title, its employer and its dates became three jobs with no dates at all.
  const doubled = ['Accounting Clerk', '', 'Santos Trading', '',
                   'January 2023 - June 2025', '', '', '', 'EDUCATION', ''];
  assert.deepEqual(undoubleSpace(doubled),
    ['Accounting Clerk', 'Santos Trading', 'January 2023 - June 2025', '', 'EDUCATION']);

  // Human spacing has SOME pair of lines touching, and must be left alone.
  const human = ['Accounting Clerk', 'Santos Trading', '', 'Cashier', 'SM Clark'];
  assert.deepEqual(undoubleSpace(human), human);
});

test('a label line is never mistaken for the applicant name', () => {
  // Two capitalised words, no digits, no email — every other test in
  // findName passes, and "Personal Information" was being returned as a name.
  assert.equal(findName(['PERSONAL INFORMATION', 'Juan Dela Cruz']), 'Juan Dela Cruz');
  assert.equal(findName(['Personal Data', 'Maria Santos']), 'Maria Santos');
  assert.equal(findName(['BIODATA', 'Ana Reyes']), 'Ana Reyes');
  assert.equal(findName(['Applicant Details']), '');
});

test('a heading must be a heading, not a sentence that mentions one', () => {
  // The failure this guards against: a bullet describing experience being
  // treated as the start of the experience section, swallowing the rest.
  assert.equal(headingOf('I have four years of experience in customer support'), null);
  assert.equal(headingOf('Skills gained during my internship include the following'), null);
  assert.equal(headingOf(''), null);
});

test('splitting keeps everything before the first heading as the header block', () => {
  const { head, sections } = splitSections(
    'JUAN DELA CRUZ\njuan@example.ph\n0917 123 4567\n\nEDUCATION\nHoly Angel University\n\nSKILLS\nExcel, Communication',
  );
  assert.deepEqual(head, ['JUAN DELA CRUZ', 'juan@example.ph', '0917 123 4567']);
  assert.deepEqual(sections.education, ['Holy Angel University']);
  assert.deepEqual(sections.skills, ['Excel, Communication']);
});

/* ---------------- the name ---------------- */

test('the name is found in Title Case and in ALL CAPS', () => {
  assert.equal(findName(['Juan Dela Cruz', 'juan@example.ph']), 'Juan Dela Cruz');
  assert.equal(findName(['MARIA CLARA SANTOS', '0917 000 0000']), 'Maria Clara Santos');
});

test('no name is better than a wrong name', () => {
  // Each of these used to be picked up as a person's name.
  assert.equal(findName(['CURRICULUM VITAE', 'RESUME']), '');
  assert.equal(findName(['Contact Information']), '');
  assert.equal(findName(['Block 5 Lot 12']), '');
  assert.equal(findName(['juan@example.ph']), '');
});

/* ---------------- durations ---------------- */

test('months come from a date range, in the shapes people actually write', () => {
  assert.equal(monthsFromRange('Jan 2024 - Jun 2024'), 6);
  assert.equal(monthsFromRange('January 2024 – December 2024'), 12);
  const now = new Date(2026, 7, 1);                            // August 2026
  assert.equal(monthsFromRange('Feb 2026 - Present', now), 7);
});

test('a range with no months counts whole years, not calendar years', () => {
  // "2022 to 2024" is two years to the person who wrote it. Reading it as
  // January 2022 through December 2024 would be 36 months — a year of
  // experience this parser invented, worth a quarter of the score.
  assert.equal(monthsFromRange('2022 to 2024'), 24);
  assert.equal(monthsFromRange('Jan 2022 - 2024'), 24);        // one end unknown is still unknown
  assert.equal(monthsFromRange('2022 - Jun 2024'), 24);
});

test('an unparseable duration is zero, never a guess', () => {
  // Zero feeds the experience component honestly; an invented number would
  // change the applicant's score on the strength of a bad regex.
  assert.equal(monthsFromRange('sometime last year'), 0);
  assert.equal(monthsFromRange('Jun 2024 - Jan 2024'), 0);     // ends before it starts
  assert.equal(monthsFromRange('Jan 1850 - Jan 1851'), 0);     // implausible
});

test('an explicit duration is read when there is no date range', () => {
  assert.equal(monthsFromWords('6 months of OJT'), 6);
  assert.equal(monthsFromWords('2 years experience'), 24);
  assert.equal(monthsFromWords('1 year 6 months'), 18);
  assert.equal(monthsFromWords('no numbers here'), 0);
});

/* ---------------- education level ---------------- */

test('education level maps onto the ranks the engine scores with', () => {
  assert.equal(levelOf('Bachelor of Science in Information Technology'), 'bachelor');
  assert.equal(levelOf('BS Business Administration'), 'bachelor');
  assert.equal(levelOf("Master's Degree in Management"), 'master');
  assert.equal(levelOf('Senior High School — ABM Strand'), 'highschool');
  assert.equal(levelOf('TESDA NC II Food and Beverage Services'), 'vocational');
  assert.equal(levelOf('Associate in Computer Technology'), 'associate');
});

test("a level that cannot be identified claims nothing", () => {
  // 'none' ranks 0. Claiming a degree the document did not state would raise
  // the education quarter of the score on no evidence.
  assert.equal(levelOf('Studied at Holy Angel University'), 'none');
  assert.equal(levelOf(''), 'none');
});

test('several degrees are each classified, so the engine can take the highest', async () => {
  /* The parser deliberately does NOT collapse education to one level — the
     engine does that itself (engine.ts takes the max of EDU_RANK across the
     list). What the parser owes it is a correct level on EVERY entry, in
     whatever order the applicant listed them. */
  const r = await parseResume(
    txt(`ANA REYES\n\nEDUCATION\nHoly Angel University\nBachelor of Science in Psychology\n2022\n\n`
      + `Ateneo Graduate School\nMaster of Arts in Industrial Psychology\n2025\n`),
    TEXT, 'ana.txt');
  assert.equal(r.status, 'ok');
  const levels = r.resume!.education.map((e) => e.level);
  assert.deepEqual(levels, ['bachelor', 'master']);

  // What the engine will actually read off this list.
  const highest = levels.reduce((top, l) => (EDU_RANK[l] > EDU_RANK[top] ? l : top), 'none');
  assert.equal(highest, 'master', 'the bachelor listed first must not cap the score');
});

/* ---------------- whole documents ---------------- */

const RESUME = `JUAN DELA CRUZ
Angeles City, Pampanga
juan.delacruz@example.ph | 0917 555 1234
linkedin.com/in/juandelacruz

OBJECTIVE
Fresh Information Technology graduate seeking an entry-level web developer role.

EDUCATION
Holy Angel University
Bachelor of Science in Information Technology
2026

WORK EXPERIENCE
Web Development Intern
LGU San Fernando
Jan 2025 - Jun 2025
• Built and maintained pages for the city job portal
• Fixed layout issues reported by staff

SKILLS
HTML/CSS, JavaScript, Git, Communication, Teamwork

CERTIFICATIONS
TESDA Web Development NC III 2025

LANGUAGES
Filipino (Native), English (Fluent)
`;

test('a plain single-column resume is read end to end', async () => {
  const r = await parseResume(txt(RESUME), TEXT, 'juan-resume.txt');
  assert.equal(r.status, 'ok');
  const res = r.resume!;

  assert.equal(res.personal.fullName, 'Juan Dela Cruz');
  assert.equal(res.personal.email, 'juan.delacruz@example.ph');
  assert.match(res.personal.phone, /0917/);
  assert.match(res.personal.linkedin ?? '', /linkedin\.com\/in\/juandelacruz/);
  // The header holds no portfolio. The only host in it is the one inside the
  // email address, and that must not be offered as one.
  assert.equal(res.personal.portfolio, undefined);

  // The three fields the ENGINE reads — the only ones that move a score.
  assert.equal(res.education[0].level, 'bachelor', 'education level feeds 25% of the score');
  assert.equal(res.experience[0].months, 6, 'months feed 25% of the score');
  for (const s of ['HTML/CSS', 'JavaScript', 'Git', 'Communication', 'Teamwork'])
    assert.ok(res.skills.some((x) => x.toLowerCase() === s.toLowerCase()), 'missing skill: ' + s);

  assert.match(res.education[0].school, /Holy Angel/);
  assert.equal(res.education[0].year, '2026');
  assert.match(res.experience[0].position, /Web Development Intern/);
  assert.match(res.experience[0].company, /LGU San Fernando/);
  assert.equal(res.experience[0].bullets?.length, 2);
  assert.equal(res.template, 'combination');
  assert.ok(res.languages?.some((l) => l.name === 'Filipino' && l.proficiency === 'Native'));
});

test('a portfolio in the header is still read once the addresses are struck out', async () => {
  const r = await parseResume(
    txt('ANA REYES\nana.reyes@gmail.com\ngithub.com/anareyes\n\nSKILLS\nJavaScript\n'),
    TEXT,
    'ana.txt',
  );
  assert.equal(r.resume!.personal.portfolio, 'github.com/anareyes');
});

test('a document with no readable text fails rather than returning an empty resume', async () => {
  // An empty resume would score a confident zero and present it to the
  // applicant as a fact about them. Failing says what actually happened.
  const r = await parseResume(txt('   \n  \n '), TEXT, 'blank.txt');
  assert.notEqual(r.status, 'ok');
  assert.equal(r.resume, null);
  assert.match(r.message ?? '', /no text|readable/i);
});

test('prose with none of a resume in it fails', async () => {
  const r = await parseResume(
    txt('This is a letter to my landlord about the broken tap in the kitchen sink. Please send someone.'),
    TEXT, 'letter.txt');
  assert.equal(r.status, 'failed');
  assert.equal(r.resume, null);
});

test('an image is refused with a reason, not a silent empty result', async () => {
  const r = await parseResume(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'scan.jpg');
  assert.equal(r.status, 'unreadable');
  assert.match(r.message ?? '', /scan|photo|AI/i);
});

test('an old .doc is refused with the advice that fixes it', async () => {
  const r = await parseResume(txt('x'), 'application/msword', 'old.doc');
  assert.equal(r.status, 'unreadable');
  assert.match(r.message ?? '', /PDF/i);
});

/* ---------------- the honest limits ---------------- */

test('a two-column layout degrades — and the study says so', async () => {
  // Two columns arrive as interleaved lines. The parser must not pretend to
  // have understood it; whatever it returns, it must not invent a duration.
  const twoCol = `JUAN DELA CRUZ
SKILLS                          EDUCATION
JavaScript                      Holy Angel University
Communication                   BS Information Technology
`;
  const r = await parseResume(txt(twoCol), TEXT, 'two-column.txt');
  if (r.status === 'ok') {
    for (const e of r.resume!.experience) assert.equal(e.months, 0, 'no duration may be invented from a mangled layout');
  }
});

test('the catalogue sweep matches whole words only, so Java is never JavaScript', () => {
  /* The sweep is the rule most likely to over-credit an applicant, so it is
     tested against a vocabulary directly rather than through the database. */
  const vocab = new Map([
    ['java', 'Java'], ['javascript', 'JavaScript'], ['excel', 'Excel'],
    ['customerservice', 'Customer Service'], ['go', 'Go'],
  ]);

  const onlyJava = sweepVocabulary('SKILLS\nJava, Customer Service', vocab);
  assert.deepEqual([...onlyJava.keys()].sort(), ['customerservice', 'java']);

  const onlyJs = sweepVocabulary('Built the front end in JavaScript.', vocab);
  assert.deepEqual([...onlyJs.keys()], ['javascript'], 'JavaScript must not also credit Java');

  assert.equal(sweepVocabulary('An excellent communicator.', vocab).size, 0,
    '"Excel" must not be found inside "excellent"');
  assert.equal(sweepVocabulary('I go to work early.', vocab).size, 0,
    'two-letter terms are never swept out of ordinary prose');
});

test('a skill named only in a job description is still credited', async () => {
  // Not through the sweep here (no database in the test), but the skills
  // section itself must survive being written as one comma-separated line.
  const r = await parseResume(txt(`ANA REYES\n\nSKILLS\nJava\n\nEDUCATION\nBS Computer Science\n`), TEXT, 'a.txt');
  assert.equal(r.status, 'ok');
  const skills = r.resume!.skills.map((s) => s.toLowerCase());
  assert.deepEqual(skills, ['java']);
});

test('entries are split on blank lines, and on dates when there are none', () => {
  // Two jobs run together with no blank line — the layout that used to pair
  // the first job title with the second job's dates.
  const dense = groupBlocks([
    'Web Developer', 'ABC Corporation', 'Jan 2024 - Present',
    'Customer Service Representative', 'XYZ Inc', 'Jan 2022 - Dec 2023',
  ]);
  assert.equal(dense.length, 2);
  assert.deepEqual(dense[0], ['Web Developer', 'ABC Corporation', 'Jan 2024 - Present']);
  assert.deepEqual(dense[1], ['Customer Service Representative', 'XYZ Inc', 'Jan 2022 - Dec 2023']);

  // Bullets belong to the job above them and never start a new entry.
  const withBullets = groupBlocks([
    'Intern', 'LGU San Fernando', 'Jan 2025 - Jun 2025', '• Built pages', '• Fixed layout issues',
  ]);
  assert.equal(withBullets.length, 1, 'bullets must not be torn off their job');
});

/* ---------------- the two readers must be interchangeable ---------------- */

test('the rules reader answers extractResume with the same contract the AI does', async () => {
  /* The config flag is only safe if nothing downstream can tell which reader
     ran. This asserts the contract itself — the field shape, the enums, and
     the clamps sanitize() promises — over the rule-based path. The AI path
     cannot be run here (it needs a network call and a key), so what is
     verified is that the rules path satisfies the SAME invariants that
     resumes.save and the scoring engine already rely on. */
  process.env.RESUME_EXTRACTOR = 'rules';
  const { extractResume, activeExtractor } = await import('../src/lib/extract');
  assert.equal(activeExtractor(), 'rules', 'the flag must pin the reader regardless of any key present');

  const r = await extractResume(txt(RESUME), TEXT, 'juan-resume.txt');
  assert.equal(r.status, 'ok');
  const res = r.resume!;

  // Shape: every key the AI path guarantees, and no surprises in the enums.
  for (const k of ['title', 'template', 'design', 'personal', 'education', 'experience', 'skills', 'certifications'])
    assert.ok(k in res, 'missing guaranteed key: ' + k);
  assert.ok(['chronological', 'functional', 'combination'].includes(res.template));
  assert.equal(res.design, 'classic');

  // Clamps: the same limits sanitize() applies to the model's output.
  assert.ok(res.skills.length <= 30);
  assert.ok(res.education.length <= 10);
  assert.ok(res.experience.length <= 15);
  for (const e of res.education) assert.ok(e.level in EDU_RANK, 'level outside the engine\'s ranks: ' + e.level);
  for (const e of res.experience) {
    assert.ok(Number.isInteger(e.months) && e.months >= 0 && e.months <= 600);
  }

  // And the values the engine actually scores survived the round trip.
  assert.equal(res.education[0].level, 'bachelor');
  assert.equal(res.experience[0].months, 6);
  delete process.env.RESUME_EXTRACTOR;
});

test('a failure from the rules reader is a failure, not an empty resume', async () => {
  process.env.RESUME_EXTRACTOR = 'rules';
  const { extractResume } = await import('../src/lib/extract');
  const r = await extractResume(txt('   \n \n'), TEXT, 'blank.txt');
  assert.notEqual(r.status, 'ok');
  assert.equal(r.resume, null);
  delete process.env.RESUME_EXTRACTOR;
});

test('every parsed field is clamped, so a hostile document cannot flood the database', async () => {
  const huge = 'A'.repeat(5000);
  const r = await parseResume(
    txt(`JUAN DELA CRUZ\n\nSUMMARY\n${huge}\n\nSKILLS\n${Array.from({ length: 80 }, (_, i) => 'Skill' + i).join(', ')}\n`),
    TEXT, 'huge.txt');
  assert.equal(r.status, 'ok');
  assert.ok(r.resume!.personal.summary.length <= 1000);
  assert.ok(r.resume!.skills.length <= 30);
});

/* ---------------- the fallback ---------------- */

test('in auto mode, a Gemini failure is caught by the rules reader', async () => {
  /* THE POINT OF THE FALLBACK. An exhausted quota, a dropped connection or a
     reply that is not usable JSON must not turn the Upload page into a dead
     end — it must produce a worse reading, not no reading. Here Gemini is
     configured with a base URL that refuses every connection, which is the
     network-failure path; 'auto' must answer with the rules reader anyway. */
  process.env.RESUME_EXTRACTOR = 'auto';
  process.env.GEMINI_API_KEY = 'test-key-not-a-real-one';
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:1';   // nothing listens on port 1
  const { extractResume, activeExtractor } = await import('../src/lib/extract');

  assert.equal(activeExtractor(), 'gemini',
    'with a key present, auto must TRY gemini first — that is what the consent notice is written from');

  const r = await extractResume(txt(RESUME), TEXT, 'juan-resume.txt');
  assert.equal(r.status, 'ok', 'a gemini failure must not fail the extraction in auto mode');
  assert.equal(r.reader, 'rules', 'the result must say which reader actually produced it');
  assert.ok(r.resume!.skills.length > 0, 'the fallback has to produce a real reading, not an empty one');

  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_BASE_URL;
  process.env.RESUME_EXTRACTOR = 'rules';
});

test('pinned gemini does NOT fall back — a failure stays a failure', async () => {
  /* The mirror of the test above, and the reason fallbackAllowed() checks for
     'auto' specifically. An operator who pins gemini is asking to observe that
     reader; answering with a different one would hide the failure they pinned
     it to see. The extraction suite depends on this. */
  process.env.RESUME_EXTRACTOR = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key-not-a-real-one';
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:1';
  const { extractResume } = await import('../src/lib/extract');

  const r = await extractResume(txt(RESUME), TEXT, 'juan-resume.txt');
  assert.notEqual(r.status, 'ok', 'a pinned gemini reader must report its own failure');
  assert.equal(r.resume, null, 'and must never invent a resume out of a failed call');

  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_BASE_URL;
  process.env.RESUME_EXTRACTOR = 'rules';
});

/* ---------------- the confidence check ---------------- */

const reading = (o: any) => ({
  title: '', template: 'chronological', design: 'classic',
  personal: { fullName: '', email: '', phone: '', address: '', summary: '' },
  education: [], experience: [], skills: [], certifications: [], ...o,
} as any);

test('a reading with nothing in it is thin, and so is no reading at all', () => {
  assert.equal(thinReading(null).thin, true);
  assert.deepEqual(thinReading(null).empty, ['name', 'skills', 'education', 'experience']);
  assert.equal(thinReading(reading({})).thin, true);
});

test('one empty field is ordinary, two is a document we did not understand', () => {
  // A fresh graduate with no paid work is the case this must NOT escalate on:
  // name, skills and education all present, experience genuinely zero.
  const fresh = reading({
    personal: { fullName: 'Juan Dela Cruz', email: '', phone: '', address: '', summary: '' },
    skills: ['JavaScript'],
    education: [{ school: 'HAU', degree: 'BSIT', level: 'bachelor', year: '2025' }],
    experience: [],
  });
  assert.equal(thinReading(fresh).thin, false);
  assert.deepEqual(thinReading(fresh).empty, ['experience']);

  // The online-builder case: a name was found and nothing else was.
  const nameOnly = reading({
    personal: { fullName: 'Paolo Reyes', email: '', phone: '', address: '', summary: '' },
  });
  assert.equal(thinReading(nameOnly).thin, true);
});

test('experience counts MONTHS, not entries', () => {
  // An entry the parser split badly can carry a title and no duration. That
  // is exactly the shape the double-spacing bug produced, and it must read as
  // empty — months are what the score uses.
  const zeroMonths = reading({
    personal: { fullName: 'Liza Cruz', email: '', phone: '', address: '', summary: '' },
    experience: [{ position: 'Accounting Clerk', company: '', months: 0, description: '' }],
  });
  assert.deepEqual(thinReading(zeroMonths).empty, ['skills', 'education', 'experience']);
  assert.equal(thinReading(zeroMonths).thin, true);
});

/* ============================================================
   Reading a CURRICULUM VITAE, not a resume.

   A five-page academic CV was uploaded to the live site and scored 25 out
   of 100 — the whole of it the experience component, which happened to be
   full of the wrong thing. The applicant holds a doctorate and thirteen
   years of university teaching. Every failure below is one this parser
   actually committed on that document, and each test names the specific
   damage rather than the pattern that fixes it.
   ============================================================ */

test('a wrapped sentence ending in a heading word does not start a section', () => {
  // The line that did the damage. A faculty duty wrapped so that
  // "employment." sat alone; the full stop was trimmed and it matched the
  // experience heading, so everything below a mid-bullet line was read as
  // employment history and everything above it was discarded.
  assert.equal(headingOf('employment.'), null);
  assert.equal(headingOf('experience.'), null);
  assert.equal(headingOf('qualifications.'), null);

  // A heading someone chose to punctuate is still a heading, and a heading
  // with no full stop is unaffected.
  assert.equal(headingOf('EDUCATION.'), 'education');
  assert.equal(headingOf('Education.'), 'education');
  assert.equal(headingOf('employment'), 'experience');
});

test('curriculum vitae section names are recognised', () => {
  assert.equal(headingOf('CAREER DETAILS'), 'experience');
  assert.equal(headingOf('Career Details -'), 'experience');
  assert.equal(headingOf('SKILLS MATRIX'), 'skills');
  assert.equal(headingOf('Education and Qualifications'), 'education');
  assert.equal(headingOf('Educational Attainment'), 'education');
  assert.equal(headingOf('Academic Background'), 'education');
});

test('sections that are not experience end the section above them', () => {
  // "PROFESSIONAL ORGANIZATION" matched no rule, so it did not close the
  // section before it and three society memberships were read as jobs:
  // "Member, 2016 to present" alone contributed ten years of employment.
  assert.equal(headingOf('PROFESSIONAL ORGANIZATION'), 'other');
  assert.equal(headingOf('Hobbies and Interests'), 'other');
  assert.equal(headingOf('PERSONAL ATTRIBUTES'), 'other');

  const { sections } = splitSections([
    'CAREER DETAILS',
    'Field Officer, LGU San Fernando  Jan 2020 - Dec 2022',
    'PROFESSIONAL ORGANIZATION',
    'PHILIPPINE SOCIETY OF IT EDUCATORS',
    'Member, 2016 to present',
  ].join('\n'));
  assert.equal(sections.experience.length, 1);
  assert.ok(!sections.experience.join(' ').includes('Member'));
});

test('a doctorate is read as the top of the education scale', () => {
  // EDU_RANK stops at master, so a doctorate belongs there. With no pattern
  // at all it read as 'none', and a posting asking for a bachelor's degree
  // scored the holder of a doctorate zero on a quarter of the total.
  assert.equal(levelOf('Doctor of Information Technology (DIT)'), 'master');
  assert.equal(levelOf('PhD in Computer Science'), 'master');
  assert.equal(levelOf('Doctorate in Education'), 'master');
  // Still distinguishes the levels below it.
  assert.equal(levelOf('Bachelor of Science in Computer Science'), 'bachelor');
});

test('a surname split by a stray hyphen is still a name', () => {
  // A PDF renders "SALENGA-MENDEZ" as "SALENGA - MENDEZ". The bare "-" is
  // not a word, the line failed the name test, and the reader fell through
  // to the line below — returning the job title "College Faculty" as the
  // applicant's name.
  assert.equal(findName(['JEANKY SALENGA - MENDEZ', 'College Faculty']), 'Jeanky Salenga-Mendez');
  // Each part of the compound is capitalised, not just the first.
  assert.equal(findName(['MARIA SANTOS-REYES']), 'Maria Santos-Reyes');
  assert.equal(findName(['Juan Dela Cruz']), 'Juan Dela Cruz');
});

test('"PERSONAL INFORMATION" stays out of the way of the contact block', () => {
  // A banner over the name and contact details, which is how many Philippine
  // resumes open. It must NOT be treated as a section: the name, email and
  // phone are found in the text BEFORE the first heading, so claiming this
  // line would empty that region and cost every such resume its contact
  // details. This is the trap the 'other' bucket could easily have set.
  assert.equal(headingOf('PERSONAL INFORMATION'), null);
  assert.equal(headingOf('Personal Details'), null);

  const { head, sections } = splitSections([
    'PERSONAL INFORMATION',
    'Juan Dela Cruz',
    'juan.delacruz@example.ph',
    '0917 123 4567',
    'SKILLS',
    'JavaScript, HTML/CSS',
  ].join('\n'));
  assert.equal(findName(head), 'Juan Dela Cruz');
  assert.ok(head.join(' ').includes('juan.delacruz@example.ph'));
  assert.ok(sections.skills.join(' ').includes('JavaScript'));

  // A genuinely prose section is still discarded, which is what 'other' is for.
  assert.equal(headingOf('PERSONAL ATTRIBUTES'), 'other');
});

/* ============================================================
   THE ORDINARY-RESUME CORPUS.

   The curriculum vitae repairs above were made against ONE document, which
   is exactly the way a reader gets tuned to one document and quietly made
   worse for every other. These ten fixtures are the shapes the study's
   actual population writes — fresh graduates, OJT and practicum, Philippine
   layouts — and they exist so that a change made for a CV has to prove it
   left them alone.

   Each expectation below is what the reader produced BEFORE the CV work,
   recorded from the previous commit and asserted here unchanged. They are
   not aspirations; they are the status quo, and a diff in this table is a
   regression until somebody says otherwise.

   The skill COUNT is asserted rather than the skill names. The count is the
   same whether or not the catalogue can be read from the database; the names
   are not, because a term the catalogue knows is reported under the
   catalogue's spelling ("MS Office") and the same term is otherwise reported
   as the resume wrote it ("Microsoft Office"). Asserting names would make
   this suite pass or fail on whether a database happened to be reachable,
   which is not what it is here to check. The count still catches the failure
   it was written for: a section that ends early loses whole skills, not
   spellings.
   ============================================================ */
/* Five fixtures run open-ended ranges ending in "Present", so their month
   counts grow by one on the first of every month. Frozen at 39, the suite passed for a year and then
   failed on 1 September 2026 for no reason connected to the code. Bumping it to
   40 would buy exactly one more month, so the expectation is expressed the way
   the fixture is written: counted from its start date to the current month,
   inclusive of both, which is the rule the reader itself applies. */
const monthsSince = (year: number, month: number) => {
  const now = new Date();
  return (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month) + 1;
};

const CORPUS: Record<string, { name: string; skills: number; education: number; level: string; months: number }> = {
  '01-fresh-grad-ojt.txt':          { name: 'Juan Dela Cruz',       skills: 5, education: 1, level: 'bachelor',   months: 4 },
  // "June 2023 - Present" — open-ended, so this one is counted, not frozen.
  '02-spaced-headings.txt':         { name: 'Maria Santos',         skills: 3, education: 1, level: 'bachelor',   months: monthsSince(2023, 6) },
  '03-numbered-practicum.txt':      { name: 'Ana Reyes',            skills: 4, education: 1, level: 'bachelor',   months: 5 },
  // The banner that must NOT become a section, or the contact block is lost.
  '04-personal-info-banner.txt':    { name: 'Juan Miguel Dela Cruz', skills: 5, education: 1, level: 'bachelor',  months: 4 },
  // March 2023 - Present, plus a closed June-October 2022 run of five months.
  '05-employment-history.txt':      { name: 'Ana Marie Reyes',      skills: 4, education: 1, level: 'bachelor',   months: monthsSince(2023, 3) + 5 },
  // Carries the word "employment." alone on a wrapped line, mid-bullet.
  // January 2018 - Present.
  '06-prose-trap.txt':              { name: 'Roberto Lim',          skills: 4, education: 1, level: 'bachelor',   months: monthsSince(2018, 1) },
  // March 2021 - Present.
  '07-arrow-bullets.txt':           { name: 'Grace Ann Lopez',      skills: 4, education: 1, level: 'bachelor',   months: monthsSince(2021, 3) },
  // June 2024 - Present.
  '08-lowercase-headings.txt':      { name: 'Marco Antonio Garcia', skills: 3, education: 1, level: 'bachelor',   months: monthsSince(2024, 6) },
  '09-inline-skills.txt':           { name: 'Liza Mae Cruz',        skills: 4, education: 1, level: 'vocational', months: 3 },
  '10-no-experience-fresh-grad.txt':{ name: 'Patricia Anne Bautista', skills: 5, education: 1, level: 'bachelor', months: 4 },
};

test('ordinary resumes read exactly as they did before the CV repairs', async () => {
  const dir = path.join(__dirname, 'fixtures');
  for (const [file, want] of Object.entries(CORPUS)) {
    const buf = fs.readFileSync(path.join(dir, file));
    const r = await parseResume(buf, 'text/plain', file);
    assert.equal(r.status, 'ok', `${file} must still be readable`);
    const got = r.resume!;
    let level = 'none';
    for (const e of got.education) if ((EDU_RANK[e.level] ?? 0) > (EDU_RANK[level] ?? 0)) level = e.level;
    const months = got.experience.reduce((t, e) => t + (Number(e.months) || 0), 0);

    assert.equal(got.personal.fullName, want.name, `${file}: name`);
    assert.equal(got.skills.length, want.skills, `${file}: skill count`);
    assert.equal(got.education.length, want.education, `${file}: education entries`);
    assert.equal(level, want.level, `${file}: highest education level`);
    assert.equal(months, want.months, `${file}: total months`);
  }
});

test('no catalogued skill name is treated as a section heading', () => {
  /* A section name that is also a skill name is a silent data-loss bug: the
     line is read as a heading, the section it was in ends there, and every
     skill listed below it is discarded. This happened — "Organization" was
     added to the list of curriculum-vitae sections to ignore, and it is one
     of the twenty-five skills in the catalogue, so a resume listing it in a
     skills column lost everything after it.

     The catalogue is read from the schema file rather than restated here, so
     a skill added to the seed is checked automatically and this test cannot
     quietly fall out of date with the thing it is protecting. */
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'linaw_ph.sql'), 'utf8');
  const block = schema.slice(schema.indexOf('INSERT INTO skills'));
  const names = [...block.slice(0, block.indexOf(';')).matchAll(/\('([^']+)','[^']+','[^']+'\)/g)].map((m) => m[1]);

  assert.ok(names.length >= 20, `expected the skill catalogue, found ${names.length} names`);
  for (const skill of names) {
    assert.equal(headingOf(skill), null, `"${skill}" is a catalogued skill and must not read as a heading`);
    assert.equal(headingOf(skill.toUpperCase()), null, `"${skill.toUpperCase()}" must not read as a heading`);
  }
});
