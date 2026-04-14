---
name: export
description: Export research artifacts — sources to BibTeX for citation managers, evidence tables to CSV for analysis, full outputs to structured JSON. Use when the user wants to export, download, or convert research outputs to standard formats.
---

# Export

Export research artifacts using the appropriate tool:

- **BibTeX** — `export_bibtex` converts source lists to `.bib` files for citation managers (Zotero, Mendeley, LaTeX)
- **CSV** — `export_csv` converts evidence tables, extraction sheets, or comparison matrices to `.csv` for spreadsheet or statistical analysis
- **JSON** — `export_json` converts full research outputs to structured `.json` for programmatic consumption

Ask the user which format they need, or infer from context. Output files are saved to `outputs/`.
