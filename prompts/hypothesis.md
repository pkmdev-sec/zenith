---
description: Generate testable hypotheses from research gaps and literature analysis
args: <domain_or_question>
section: Research Workflows
topLevelCli: true
---
Generate testable hypotheses for: $@

Derive a short slug from the domain or question (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all files in this run.

## Workflow

1. **Survey** — Use the `researcher` subagent to survey the field. Identify: established findings with strong consensus, open questions under active investigation, contradictions between studies, and methodological limitations in current approaches.
2. **Gap analysis** — Map what IS studied vs what IS NOT. Identify: unexplored variable combinations, untested assumptions taken for granted, missing replications across populations or contexts, methodological gaps (e.g., only correlational studies where causal claims are made), and theoretical predictions that lack empirical tests.
3. **Generate** — For each identified gap, generate 1-3 hypotheses. Format each as:
   - **H[N]:** Statement (one falsifiable sentence)
   - **Variables:** IV, DV, key controls
   - **Prediction:** Expected outcome and direction of effect
   - **Rationale:** Why this follows from existing evidence (cite sources)
   - **Testability:** What experiment or study design would test this
   - **Novelty:** Why this hasn't been tested, or why existing tests are insufficient
   - **Risk:** What would falsify this hypothesis; what the strongest counterargument is
4. **Prioritize** — Rank hypotheses on four dimensions: feasibility (can it be tested with available methods/resources?), impact (would confirmation change the field?), novelty (how far from existing work?), testability (how cleanly can it be tested?). Recommend the top 3-5 with justification.
5. **Deliver** — Save to `outputs/<slug>-hypotheses.md`. Run `verify_citations` on all referenced sources.
