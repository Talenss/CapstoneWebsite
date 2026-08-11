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
| `ResumeMatch-PH-Codebase.docx` | Every source file in the repository and what it does, plus the scoring engine in full with its rounding rule, the fourteen database CHECK constraints, the seven steps a single application takes from Apply to a ranked list, and the security that is actually implemented — including the gaps. |

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
9. **Automated testing** — six suites totalling 140 tests under CI (engine 37,
   API 46, email 10, extraction 10, demo/API parity 13, and the rule-based
   document reader 24), plus scripted browser walkthroughs that drive the real
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
