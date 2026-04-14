---
description: Map citation networks, identify seminal papers and research fronts
args: <seed_paper_or_topic>
section: Research Workflows
topLevelCli: true
---
Map the citation network for: $@

Derive a short slug from the seed paper or topic (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all files in this run.

## Workflow

1. **Seed** — Identify 1-5 seed papers. If the user provides a topic rather than specific papers, use `scholar_search` and `alpha_search` to find the most-cited papers in the area. Use `scholar_paper` to get full details for each seed.
2. **Expand** — For each seed paper: run `scholar_citations` (who cited this?) and `scholar_references` (what does this cite?). Build a citation graph tracking: paper ID, title, authors, year, citation count, and relationship type (cites / cited-by). Expand iteratively for high-impact nodes (2 hops from seeds for top-cited papers, 1 hop otherwise).
3. **Analyze** — From the graph, identify: (a) Seminal papers — highest in-degree, foundational to the field. (b) Bridge papers — connect distinct research clusters. (c) Research fronts — recent papers with high citation velocity. (d) Key authors — use `scholar_author` for top contributors, note prolific vs influential. (e) Temporal trends — when key ideas emerged and shifted.
4. **Visualize** — Mermaid diagram of the citation network (top 20-30 papers, edges showing citation direction). Timeline of key publications by year. Use `pi-charts` for citation distribution and trend analysis.
5. **Report** — Save to `outputs/<slug>-citation-network.md`. Include: network summary statistics, seminal papers table (title, year, citations, role), research fronts, key authors, temporal timeline, and methodology notes (search dates, expansion depth, inclusion thresholds).
