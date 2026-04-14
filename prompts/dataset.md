---
description: Discover and evaluate datasets for research tasks
args: <task_or_domain>
section: Research Workflows
topLevelCli: true
---
Discover and evaluate datasets for: $@

Derive a short slug from the task or domain (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all files in this run.

## Workflow

1. **Requirements** — Clarify with the user: What task or domain? What data types needed (text, images, tabular, time-series)? Size requirements? Licensing constraints (commercial use, share-alike)? Quality requirements (human-labeled, documentation, known biases)?
2. **Search** — Search across sources using `web_search`: HuggingFace Datasets, Kaggle, UCI ML Repository, Papers With Code Datasets, Google Dataset Search, data.gov, and domain-specific repositories. Also use `scholar_search` to find papers that introduce or benchmark datasets in the domain.
3. **Catalog** — For each candidate dataset: name, source URL, size (rows/samples and storage), format (CSV, Parquet, JSONL, images), license, documentation quality (datasheet/Croissant metadata available?), citation count, last updated, and known issues or biases.
4. **Evaluate** — Score each dataset on: relevance (match to the stated task), quality (labeling accuracy, documentation, known biases), accessibility (open access vs registration vs paid), recency (last update, actively maintained), and community adoption (papers using it, benchmark leaderboards, download counts).
5. **Compare** — Build a comparison matrix of the top candidates across all evaluation dimensions. Recommend the best option(s) with clear rationale and note tradeoffs.
6. **Deliver** — Save the report to `outputs/<slug>-datasets.md`. Export the comparison table via `export_csv`.
