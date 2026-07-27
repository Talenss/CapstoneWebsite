# Capstone documents

Deliverables for the manuscript and for the adviser. These are generated
documents, not source — the system itself is the folder above.

| File | What it is |
|---|---|
| `ResumeMatch-PH-Design-Specification.pdf` | 20-page design specification: site map, user flows, five wireframes, two mockups, the design system, use case diagram, ERD, the matching algorithm, the API surface, the testing strategy, and the build sequence. Written for the adviser as the "everything you need to start building" document. |
| `ResumeMatch-PH-Updated-Manuscript-Sections.docx` | Copy-paste-ready replacement text for every section of the capstone paper that the built system has outgrown. Eleven substantive changes, each section reproduced in full between BEGIN/END markers. |

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
4. **Scoring inputs** — skills, education and experience only. Certifications
   are stored and shown but not scored; there is no Projects section.
5. **Published weights** — skills 50 / education 25 / experience 25, tiers at
   80 and 50, stored as database configuration.
6. **Three content formats × eight parser-safe designs.**
7. **Two resumes per applicant** — the structured one is scored; the uploaded
   file is forwarded but never parsed.
8. **Six application statuses**, including applicant withdrawal, with an audit
   trail naming the recruiter behind every change.
9. **Automated testing** — 29 engine tests and 16 API integration tests under
   CI, alongside the ISO 25010 evaluation.
10. **Security and data rights** — email verification, hashed passwords,
    role-based access, applicant data export, account deletion.
11. **Department-based routing** of new applications.

## Regenerating

Both documents are generated from scripts kept with the session that produced
them; they are committed here as finished artifacts. If a document needs to
change, edit it in Word/Google Docs, or ask for a regeneration.
