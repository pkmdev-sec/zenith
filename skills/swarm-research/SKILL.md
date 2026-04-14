---
name: swarm-research
description: "Swarm intelligence research — spawn dozens to hundreds of diverse agents that independently investigate, debate, and cross-verify findings. Produces multi-perspective analysis with confidence scores."
---

Swarm research uses many parallel agents with diverse expertise, methodologies, and stances
to investigate a question from every angle simultaneously. Unlike /deepresearch (4-agent pipeline),
/swarm produces emergent consensus through agent diversity and adversarial cross-examination.

Scale options: `focused` (10-15 agents), `standard` (30-50), `deep` (100-200), `massive` (500-1000).
Default: standard.

Agents: swarm-researcher (many), debate-agent (5-10), swarm-verifier (5-10).
Output: `outputs/<slug>-swarm.md` with `.provenance.md` sidecar.

Run the `/swarm` workflow. Confirm the plan and scale before agent spawning begins.
