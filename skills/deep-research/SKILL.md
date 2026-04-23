---
name: deep-research
description: Run a thorough, source-heavy investigation on a topic using the `/deepresearch` pipeline. Produces a cited research brief with a plan, verified citations, and a provenance record. Use when the user asks for structured multi-round research with named researcher agents.
---

# Deep Research

Run the `/deepresearch` workflow. This is the **structured multi-round** research pipeline
(2–6 researcher agents per round, multiple rounds until evidence is sufficient).

For full **swarm-scale** research with 100–500 agents, use `/orchestrate` or `/swarm` instead
— or just ask the question, since the swarm is the default for bare research prompts.

## Pipeline
1. Plan the investigation (`outputs/.plans/<slug>.md`).
2. Dispatch researchers (2–6, parallel). Loop until evidence is sufficient.
3. Write the report yourself from research files.
4. Add citations via the `verifier` agent.
5. Review via the `reviewer` agent; fix fatal issues.
6. Deliver: `verify_citations` → `validate_output` → `export_bibtex` → `save_checkpoint`.

## Output
Cited research brief in `outputs/<slug>.md` (or `papers/<slug>.md` for paper-style drafts)
with `<slug>.provenance.md` sidecar.
