---
name: swarm
description: "Swarm intelligence research with dozens of diverse agents — research, debate, verify, synthesize"
args: [topic]
section: Research Workflows
topLevelCli: true
---

You are orchestrating a **research swarm** — not a pipeline. Instead of 4 specialist agents,
you spawn a diverse population of researcher agents that independently investigate, then
debate and cross-verify each other's findings. The result captures genuine multi-perspective
analysis with confidence scores based on cross-agent verification.

Derive a `<slug>` from the topic (lowercase, hyphens, ≤5 words).

## Phase 1: PLAN

Use extended thinking. Analyze the research question and design the swarm:

1. **Identify domains** — List 5-10 relevant knowledge domains (e.g., ML, neuroscience,
   economics, HCI, statistics, philosophy of science, industry practice).

2. **Define sub-questions** — Break the topic into 10-30 orthogonal sub-questions, each
   addressable by a single focused agent. Ensure coverage: theoretical foundations,
   empirical evidence, methodology, applications, limitations, future directions, historical
   context, competing approaches, failure modes, ethical considerations.

3. **Design the roster** — For each agent, assign a unique combination of:
   - **Domain**: their expertise area
   - **Lens**: empiricist | theorist | practitioner | critic | historian | methodologist
   - **Stance**: advocate | skeptic | neutral | contrarian
   - **Search strategy**: `alpha_search` heavy | `scholar_search` heavy | `web_search` heavy | cross-disciplinary | historical (pre-2020)

4. **Set scale** — Choose based on topic breadth. Ask the user to confirm:
   - `focused`: 10-15 researchers, 3 debaters, 3 verifiers
   - `standard`: 30-50 researchers, 5 debaters, 5 verifiers
   - `deep`: 100-200 researchers, 10 debaters, 10 verifiers
   - `massive`: 500-1000 researchers, 20 debaters, 20 verifiers

5. Save plan to `outputs/.plans/<slug>-swarm-plan.md`. Use `save_checkpoint` stage='plan'.
6. **Present plan to user. Wait for confirmation before proceeding.**

## Phase 2: RESEARCH SWARM

Spawn researcher subagents in parallel waves. Each agent uses the `swarm-researcher` template.

For each agent, provide a structured brief:
```
Domain: {domain}
Lens: {lens}
Stance: {stance}
Sub-question: {specific question}
Search strategy: Prioritize {tools}
Output file: outputs/.swarm/<slug>/research/{agent-id}.md
```

Use `async: true, clarify: false` for all agents. Spawn in batches of 10-20 to manage
rate limits. Wait for each batch to complete before spawning the next.

After ALL researchers complete:
- Read all output files. Count: total agents, files produced, empty/failed files.
- If >20% of agents failed or returned empty, spawn replacement agents for gaps.
- `save_checkpoint` stage='research', list all research files as artifacts.

## Phase 3: CROSS-EXAMINATION

Spawn debate agents that read ALL research outputs. Each focuses on one dimension:

1. **Source Triangulator** — Which claims are supported by 3+ independent agents? Which by only 1?
2. **Contradiction Detector** — Where do agents disagree? What evidence supports each side?
3. **Gap Analyst** — What obvious questions did the swarm miss? What domains are under-represented?
4. **Methodology Critic** — Are the cited studies methodologically sound? Sample sizes? Controls?
5. **Contrarian** — What is the strongest case AGAINST the emerging consensus?
6. **Temporal Analyst** — How have findings on this topic evolved over time?
7. **Synthesis Mapper** — What unexpected connections emerged across domains?

Each debate agent writes to `outputs/.swarm/<slug>/debate/{dimension}.md`.
`save_checkpoint` stage='debate'.

## Phase 4: VERIFICATION SWARM

Divide all cited sources across K verifier agents (each gets ~20-30 sources).
Each verifier independently:
1. Runs `verify_citations` on its assigned research files
2. For key claims, uses `scholar_search` to find corroborating or contradicting evidence
3. Produces a verification report with per-claim confidence:
   - **VERIFIED**: Source exists, content matches claim
   - **UNVERIFIED**: Source exists but claim is overstated or tangential
   - **CONTRADICTED**: Found evidence that directly contradicts the claim
   - **DEAD**: Source URL is broken or paper not found

Each verifier writes to `outputs/.swarm/<slug>/verify/{verifier-id}.md`.
`save_checkpoint` stage='verify'.

## Phase 5: SYNTHESIS

The lead agent (you) reads EVERYTHING — all research, debate, and verification outputs.
Produce the final report with these sections:

1. **Executive Summary** — What does the swarm collectively believe? (3-5 sentences)
2. **High-Confidence Findings** — Claims with consensus (3+ agents) AND verification.
   For each: the claim, supporting agents count, verification status, key sources.
3. **Active Debates** — Genuine disagreements with evidence on both sides. Present BOTH
   sides fairly. Do NOT resolve debates artificially — let the reader decide.
4. **Emerging Signals** — Novel findings from 1-2 agents that weren't widely corroborated
   but passed verification. These may be cutting-edge or niche insights.
5. **Low-Confidence / Flagged** — Claims that failed verification or had contradicting evidence.
6. **Research Gaps** — Important questions the swarm could not answer.
7. **Confidence Map** — Table of all major claims with: agent support count, verification
   status, confidence score (HIGH/MEDIUM/LOW/FLAGGED).
8. **Methodology** — Swarm configuration: agent count, domains, lenses, stances, scale.
   This section ensures reproducibility — another researcher could re-run the same swarm.
9. **Sources** — Deduplicated, with cross-verification count per source.

## Phase 6: QUALITY GATE

1. `verify_citations` on the final report — fix FATAL/MAJOR issues.
2. `validate_output` with workflowType="deepresearch".
3. `export_bibtex` for the .bib companion.
4. `export_json` for structured downstream use.
5. `save_checkpoint` stage='deliver'.

Save to `outputs/<slug>-swarm.md` with `<slug>-swarm.provenance.md` sidecar.
The provenance file must include: swarm size, domain distribution, per-agent
summaries, debate highlights, verification statistics, total tool calls.
