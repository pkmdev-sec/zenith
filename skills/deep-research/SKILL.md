---
name: deep-research
description: Run a thorough, source-heavy investigation on any topic. Dispatches researcher, verifier, and reviewer agents in a structured pipeline. Produces a cited brief with provenance tracking.
---

# Deep Research

Run the `/deepresearch` workflow for structured multi-agent investigation.

This is the moderate-scale pipeline (2-6 agents). For full swarm-scale research 
with 100-500 agents, use `/orchestrate` instead (or just ask your question — 
the swarm is the default).

## Pipeline
1. Plan the investigation
2. Dispatch researchers (2-6, parallel)  
3. Synthesize findings
4. Add citations (verifier)
5. Quality review (reviewer)
6. Deliver to `outputs/`

## Output
Cited research brief in `outputs/<slug>.md` with `<slug>.provenance.md` sidecar.
