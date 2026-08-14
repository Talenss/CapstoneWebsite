# Capstone documents

Deliverables for the manuscript and for the adviser. These are generated
documents, not source — the system itself is the folder above.

| File | What it is |
|---|---|
| `ResumeMatch-PH-Design-Specification.pdf` | 20-page design specification: site map, user flows, five wireframes, two mockups, the design system, use case diagram, ERD, the matching algorithm, the API surface, the testing strategy, and the build sequence. Written for the adviser as the "everything you need to start building" document. |
| `ResumeMatch-PH-Updated-Manuscript-Sections.docx` | Copy-paste-ready replacement text for every section of the capstone paper that the built system has outgrown. Eleven substantive changes, each section reproduced in full between BEGIN/END markers. |
| `ResumeMatch-PH-Research-Instruments.docx` | The five instruments the study administers — 117 items, all closed — laid out with tick boxes so they can be printed and filled in, plus an administration sheet. Instrument C carries four items repeated word for word from Instrument A, so the change in one respondent's own answer can be tested, and the ten items of the System Usability Scale, scored on their own 0–100 scale. Instrument E is a ranking task: the recruiter orders five résumés and the study computes Spearman's rank correlation against the system's order. Generated from the same source as the manuscript's Appendix A, so the two cannot drift apart. |
| `ResumeMatch-PH-Google-Forms.docx` | The same five instruments laid out as Google Forms questions — question type, options and section descriptions for every item — plus the checklist for what to do once responses are in. Generated from the same source, for the same reason. |
| `ResumeMatch-PH-Study-Guide.docx` | The defence study guide: the whole paper section by section, then 120 practice questions with answers written to be said out loud, defence notes, alignment checks and the five figures. Part 4 works every statistic in the study by hand — weighted mean and SD, Wilcoxon signed-rank, the System Usability Scale, Spearman's rho and Cronbach's alpha — on numbers small enough to reproduce with a pen. |
| `ResumeMatch-PH-Codebase.docx` | Every source file in the repository and what it does, plus the scoring engine in full with its rounding rule, the sixteen database CHECK constraints, the seven steps a single application takes from Apply to a ranked list, and the security that is actually implemented — including the gaps. |
| `ResumeMatch-PH-Start-Here.docx` | The short guide, for a groupmate who did not build the system. The study, the website, the score with a worked example, where the AI is and is not, twelve questions with answers, and the numbers to memorise. About 25 minutes. |
| `ResumeMatch-PH-Website-Guide.docx` | Every page and every feature, in the order a user meets them, with three worked scores and the design decisions worth being able to defend. |
| `ResumeMatch-PH-Codebase-Guide.docx` | How the program is built, for whoever answers the technical questions: the two-adapter design, one request followed end to end, the scoring engine in full, the database, the six test suites, and how to run it. |
| `ResumeMatch-PH-Manuscript-Guide.docx` | The paper chapter by chapter in plain language — what each one argues, what the instruments measure, which statistic is used and why, and a table pointing at where each claim in the manuscript is proved in the software. |

## What the manuscript revisions cover

The paper was written before the system was built. These eleven points are
where the manuscript and the implementation had diverged:

1. **Three account types, not two** — an Administrator role (the research
   team) approves recruiter access, assigns departments, and reads the
   anonymous study metrics.
2. **PostgreSQL on Supabase, Node/Express in TypeScript** — the paper named
   MySQL and left the back end undecided.
3. **The AI delimitation** — the paper says the system uses no AI and that
   users type everything by hand. The optional upload-and-extract feature
   contradicts both. Scoring *is* rule-based; the revision says so precisely
   instead of denying that AI is used at all.
4. **Scoring inputs** — skills, education and experience only. Certifications,
   projects, languages and references are stored, printed and shown to the
   recruiter, but never scored.
5. **Published weights** — skills 50 / education 25 / experience 25, tiers at
   80 and 50, stored as database configuration.
6. **Three content formats × fourteen parser-safe designs.**
7. **Two resumes per applicant, two scores** — the structured one the
   applicant typed, and their own uploaded file, which the AI reads into the
   same fields so the same formula can score it too. Both numbers are shown,
   to the applicant and to the recruiter. **Ranking uses only the structured
   one**, so a parser misreading a scan cannot move anybody down a list; the
   file's score is reported beside it, and the gap between the two is a
   finding in its own right — it is what an ordinary screening system would
   have lost. A file that could not be read produces no score at all, never a
   zero.
8. **Six application statuses**, including applicant withdrawal, with an audit
   trail naming the recruiter behind every change.
9. **Automated testing** — six suites totalling 160 tests under CI (engine 49,
   API 52, email 10, extraction 10, demo/API parity 13, and the rule-based
   document reader 26), plus scripted browser walkthroughs that drive the real
   interface, alongside the ISO 25010 evaluation.
10. **Security and data rights** — email verification, hashed passwords,
    role-based access, applicant data export, account deletion.
11. **Department-based routing** of new applications.

## Revision of 30 July 2026

`ResumeMatch-PH-Updated-Manuscript-Sections.docx` was regenerated on 30 July.
Sixteen paragraphs changed, and one of them is a reversal rather than a
refinement: the paper's promise that the uploaded file is *never parsed and
can never lower a score* is gone, because the file is now read and scored.
The replacement text says what is true instead — both documents are scored,
both numbers are shown, and only the structured resume decides an applicant's
position in a recruiter's list. The other changes are the three new optional
sections, fourteen designs in place of eight, and the test counts.

## Regenerating

Both documents are generated from scripts kept with the session that produced
them; they are committed here as finished artifacts. If a document needs to
change, edit it in Word/Google Docs, or ask for a regeneration.

## Revision of 11 August 2026

The study's method changed, and the documents here changed with it. The
manuscript's Chapter 3 is now a **quantitative** descriptive design rather
than a qualitative one, and two things were added inside it:

- **A paired before-and-after block.** Four items of Instrument A are repeated
  word for word in Instrument C, so the change in a single respondent's own
  answer can be measured rather than inferred. The pair is tested with the
  Wilcoxon signed-rank test — the only inferential statistic and the only
  hypothesis in the study. This makes the job-seeker strand a one-group
  pretest–posttest, which is pre-experimental: no control group, no random
  assignment, and therefore no causal claim.
- **The System Usability Scale.** Ten published items, reproduced unaltered,
  scored 0–100 by their own procedure and never averaged with the ISO/IEC
  25010 items. It is included because every other figure the study produces
  comes from a researcher-made instrument and cannot be compared with anything
  outside the paper.

The instruments went from 103 items to 117. Two operational consequences are
worth knowing before the forms are built:

1. One of the four repeated items is **negatively worded**, because its
   original is. On that item an improvement is a *lower* answer.
2. The paired test compares each respondent's two answers, so the two forms
   must be linkable. Each job seeker is issued a **respondent code** with their
   invitation and enters it on both forms; no list mapping codes to people is
   kept, so responses stay anonymous while still being pairable. Without this
   the paired block cannot be analysed at all.

## Sources, as of 11 August 2026

The citation audit had flagged six references it could not trace. Checking the
manuscript rather than the audit note:

- **Five are no longer in the paper at all** — no reference entry and no in-text
  citation anywhere in the body. Miller & Zhang, Stevenson et al., Kumar et al.,
  Nielsen Norman Group and Albert et al. were removed or replaced in an earlier
  pass. There is nothing left to fix.
- **One was replaced, and the replacement now checks out.** Stanica et al. gave
  the wrong venue for CareProfSys; the entry is Dascălu et al. (2023), and that
  article is real at exactly the venue and pages cited — *Issues in Information
  Systems*, 24(3), 71–82.
- **One entry remains unconfirmed:** Đorđević (2022). The journal and the volume
  exist; the article did not surface. The entry carries a redalyc PDF link —
  opening it settles the question either way.

Two further corrections came out of the same check:

- **The SUS benchmark now has a source.** The Method promised a comparison
  against published norms and named none. It now reports against the mean of
  approximately 70 from Bangor, Kortum and Miller (2008), with the adjective
  scale from the same authors (2009) and Lewis (2018) as the review. The figure
  of 68 quoted almost everywhere online traces to a self-published practitioner
  guide and is deliberately **not** cited. The comparison is bounded in the
  text: these are norms for software in general, and no published SUS norm for
  applicant-facing recruitment systems was found.
- **"40% more viewing time" was removed.** It was attributed to TheLadders
  (2018), which does not report it. The 7.4 seconds in the same sentence is
  correct and confirmed. The sentence now states what that study does report.

The reference list is 55 entries. What has been confirmed is that these works
**exist** at the venue, volume and pages given, by cross-checking independent
index records. Nobody has read them. Six method sources in particular are now
cited and unread — Brooke, Campbell and Stanley, Wilcoxon, Bangor et al. (twice)
and Lewis — and a source confirmed to exist is not a source confirmed to support
the sentence it is attached to.

## Revision of 14 August 2026

The four study guides were regenerated against the running code. Two features
were added to the system since they were written, and both change sentences the
manuscript already contains:

- **Evidence-linked skills.** The builder asks where each skill was used, and
  the answer must point at an entry already on the applicant's own resume. A
  matched skill with a source counts in full; one without still counts, at
  half. The link is never printed on the resume — the downloaded document is
  unchanged — and appears only in the recruiter's view of the application. The
  guides state the limit as plainly as the feature: partial credit makes
  padding a skills list cost points and makes it visible, it does not prevent
  it. An applicant with one real skill out of four who types in the other three
  now reaches 81 rather than 100.
- **Rejection reasons reach the applicant.** They are told what was decided, in
  wording written for them; they are not told which member of staff decided it.
  This reverses the original design, on the grounds that a study whose stated
  problem is applicants who hear nothing back cannot record the reason and then
  withhold it from the person whose plans depend on it.

Three counts moved with them: 22 tables, 16 CHECK constraints, and 160 tests
across six suites. **The scoring formula printed in the manuscript's Chapter 3
is now incomplete** — it reads matched ÷ required and should read
(matched − unsourced × 0.5) ÷ required. That edit has not been made to the
paper yet, and the Manuscript Guide lists it under what is still open.

## The three older documents, brought in line

`ResumeMatch-PH-Codebase.docx`, `-Study-Guide.docx` and
`-Complete-Documentation.docx` predate the two features above, and had drifted
further than that. All three were updated in place on 14 August 2026:

- **Codebase.docx** promises in its own opening that line counts are read from
  the repository at generation time, so every count in it was refreshed from
  the working tree rather than hand-patched — seventeen files had moved, some
  by hundreds of lines. Also: 22 tables, sixteen CHECK constraints, the engine
  listing with its evidence term, and the end-to-end walkthrough corrected to
  say the ranked list sorts on the snapshot.
- **Study-Guide.docx** carries the answers the group says out loud, so the edit
  that matters most is **Q89 — "state the formula"**, which now includes the
  half-credit term. A new subsection 3.6 adds five questions (Q112a–e) on
  evidence-linked skills and on what a rejected applicant is told, each written
  to concede the limit before a panelist finds it. Test counts and the
  pre-defence checklist were updated; the checklist now has a fourth item, the
  Chapter 3 formula correction.
- **Complete-Documentation.docx** was the most out of date: 55 endpoints rather
  than 45, 160 tests rather than 56, fourteen résumé designs rather than eight,
  and a claim that there is no projects section — there is, along with
  languages and references, none of which is scored.

Line counts, table counts, endpoint counts and test counts in all seven
documents were read from the repository at `e26ded0`, not carried over.
