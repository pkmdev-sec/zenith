# Agents

`AGENTS.md` is the repo-level contract for agents working in this repository.

The source of truth for agent behavior is `.zenith/agents/*.md`, which the runtime syncs into the agent directory. If you need to change how any agent behaves, edit the corresponding file in `.zenith/agents/` instead of duplicating prompts here.

## Agent inventory (203 total)

### Core 4

- `researcher` — gather evidence from papers, web, repos, docs
- `writer` — structure findings into coherent drafts
- `reviewer` — simulated peer review, severity-graded feedback
- `verifier` — check citations, verify URLs, flag unsupported claims

### Swarm infrastructure

- `synthesizer` — compress hundreds of agent outputs into coherent narrative
- `coordinator` — orchestrate agent dispatch and phase transitions
- `scout` — landscape recon before the swarm fans out
- `debate-agent` — multi-role: triangulator, synthesis, temporal, contrarian, methodology critic

### Councils (consensus)

- `consensus-mapper` — find where agents agree across the swarm
- `debate-agent` (triangulator / synthesis / temporal roles) — map the shape of disagreement
- `meta-analysis-specialist` — cross-study comparison and pattern detection

### Challengers (adversarial)

- `red-team` — attack consensus, find blind spots
- `debate-agent` (contrarian / methodology critic roles) — argue against prevailing conclusions
- `bias-detector` — flag cognitive and methodological biases
- `reproducibility-checker` — flag unreproducible claims

### Domain specialists (195)

Automatically dispatched based on scout findings. Cover specific fields, methodologies, statistical techniques, and historical context. Listed in `.zenith/agents/`.

## Pipeline phases

The swarm runs a 6-phase pipeline, enforced by code gates:

1. **Scout** — landscape recon, identifies subtopics and knowledge gaps
2. **Research Swarm** — 100–500 persona agents fan out (broad: 100–200, expensive: 300–500)
3. **Cross-Examination** — councils find consensus, challengers attack it
4. **Verification** — citation checking, dead link detection, claim validation
5. **Build Chain** — synthesizer → writer → verifier → reviewer
6. **Quality Gate** — `deliver_artifact` enforces minimum quality before output

## Code-enforced gates

| Gate | Enforces |
|---|---|
| `log_agent_spawn` | Tracks every agent against a budget. No silent runaway. |
| `phase_gate` | Strict phase ordering. No skipping. |
| `deliver_artifact` | Quality threshold before writing to `~/research/`. Failures loop back. |

## Output conventions

- Final research reports: `~/research/<slug>.md`
- Working data (raw agent outputs, council deliberations, challenger attacks, intermediate drafts): `~/.zenith/swarm-work/<slug>/`
- Session logs: `~/.zenith/sessions/`

### File naming within swarm-work

Every run derives a short **slug** from the topic (lowercase, hyphens, no filler words, ≤5 words). All files in a single run use that slug:

- Events log: `events.jsonl` (append-only swarm timeline)
- Swarm manifest: `manifest.md`
- Scout output: `scout/` (scout-phase agent outputs)
- Research outputs: `research/` (persona-agent findings)
- Debate outputs: `debate/` (cross-examination council + challenger outputs)
- Verification outputs: `verify/` (citation-check and claim-verification reports)
- Build chain: `build/` (synthesizer/writer/reviewer drafts, final artifact)
- Checkpoints: `checkpoints/` (per-stage resume state from save_checkpoint)

Never use generic names like `research.md` or `draft.md`. Concurrent runs must not collide.

## Delegation rules

- The lead agent (coordinator) plans, delegates, synthesizes, and delivers.
- Use subagents when the work is meaningfully decomposable; do not spawn them for trivial work.
- Prefer file-based handoffs over dumping large intermediate results back into parent context.
- Subagents may not silently skip assigned tasks; skipped or merged tasks must be recorded.
- For critical claims, require at least one adversarial verification pass (challengers) after synthesis. Fix fatal issues before delivery or surface them explicitly.

## Provenance and verification

- Every output from `/deepresearch` includes verification metadata in the quality gate result.
- Source verification and citation cleanup belong in the verification phase, not in ad hoc edits after delivery.
- If a workflow uses the words `verified`, `confirmed`, or `checked`, the underlying artifact should record what was actually checked and how.
- Never smooth over missing checks. Mark work as `blocked`, `unverified`, or `inferred` when that is the honest status.
