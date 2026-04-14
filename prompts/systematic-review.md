---
description: PRISMA-based systematic review with structured data extraction
args: <topic>
section: Research Workflows
topLevelCli: true
---
Run a PRISMA-based systematic review for: $@

Derive a short slug from the topic (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all files in this run.

## Workflow

1. **Protocol** — Define the research question (PICO format if applicable), inclusion/exclusion criteria, search strategy, databases to search, and a data extraction template. Write the protocol to `outputs/.plans/<slug>-protocol.md`. Present to the user and confirm before proceeding.
2. **Search** — Systematic search across multiple sources: `alpha_search` (arXiv), `scholar_search` (Semantic Scholar 200M+ papers), and `web_search` for grey literature. Document for each source: database name, exact queries used, date of search, number of results. Save raw search results to `<slug>-search-log.md`.
3. **Screen** — Two-phase screening against inclusion criteria: (a) Title/abstract screening to remove clearly irrelevant records, (b) Full-text screening of remaining papers with explicit exclusion reasons. Track counts: total identified, duplicates removed, title/abstract excluded, full-text excluded (with reasons per exclusion category), final included. Save the screening log.
4. **Extract** — Structured data extraction using the template from step 1. For each included study: study design, sample size/characteristics, intervention or exposure, outcomes measured, key findings, effect sizes where reported, limitations. Use `export_csv` to save the extraction table.
5. **Assess** — Risk-of-bias assessment for each included study. Rate each domain (selection, performance, detection, attrition, reporting) as Low / Some concerns / High. Summarize the overall risk profile across studies.
6. **Synthesize** — Narrative synthesis organized by outcome or theme. Where quantitative data permits: note where meta-analysis would be appropriate, report effect sizes and heterogeneity indicators. Use `pi-charts` for forest-plot-style visualizations. Use Mermaid for the PRISMA flow diagram showing identification → screening → eligibility → included counts.
7. **Cite** — Spawn the `verifier` agent to add inline citations and run `verify_citations`.
8. **Review** — Spawn the `reviewer` agent to check methodological rigor: were inclusion criteria applied consistently, is the synthesis faithful to extracted data, are limitations acknowledged. Run `validate_output`. Fix FATAL issues before delivering; note MAJOR issues in Limitations.
9. **Deliver** — Save to `outputs/<slug>-systematic-review.md` with `outputs/<slug>-systematic-review.provenance.md` sidecar. Export the reference list via `export_bibtex`.
