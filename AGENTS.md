# Agents

`AGENTS.md` is the repo-level contract for agents working in this
repository. The source of truth for agent behavior is
`.zenith/agents/*.md`, which the runtime syncs into `~/.zenith/agent/agents/`.
If you need to change how any agent behaves, edit the corresponding file in
`.zenith/agents/` — not a duplicated block here.

## Single-model policy

Every agent in every role runs on **Anthropic `claude-opus-4-6`**. The pin
is enforced in `src/model/catalog.ts::SINGLE_MODEL_SPEC`,
`src/pi/settings.ts::choosePreferredModel`, `.zenith/settings.json`,
`~/.zenith/agent/settings.json`, and by stripping the `ANTHROPIC_MODEL`,
`ANTHROPIC_MAX_TOKENS`, `ANTHROPIC_SMALL_FAST_MODEL`, and `CLAUDE_MODEL`
env vars before spawning Pi. Do not suggest a per-agent model override —
there is no selection to make.

## Agent inventory (28 total)

17 of the 28 agent files carry the same "Swarm protocol (MiroFish-style,
3 rounds)" block: all 13 domain specialists and all 4 council/challenger
files. Each persona instance — statistics-specialist-01,
statistics-specialist-02, … — runs that protocol over the shared evidence
graph (`append_evidence`, `query_evidence_graph`) and its own memory file
(`append_persona_memory`, `read_persona_memory`). The other 11 agents
(coordinator, scout, researcher, synthesizer, writer, verifier, reviewer,
debate-agent, red-team, swarm-researcher, swarm-verifier) have their own
role-specific prompts and operate on the graph from outside the round
loop.

### Swarm infrastructure (9)

- `coordinator` — plans, delegates, synthesizes, delivers.
- `scout` — round-0 landscape recon; produces the persona pool shape.
- `researcher` — round-1 investigator (the generic specialist when a
  narrow file does not apply).
- `synthesizer` — compresses the evidence graph into a draft.
- `writer` — structures the draft.
- `verifier` — citation + URL + claim-support pass.
- `reviewer` — severity-graded peer review.
- `debate-agent` — multi-role: triangulator, synthesis, temporal,
  contrarian, methodology critic.
- `red-team` — attacks consensus, names blind spots.

### Domain specialists (13)

`statistics`, `transformer`, `nlp`, `cv`, `rl`, `robotics`,
`optimization`, `compiler`, `security`, `genomics`, `climate-science`,
`ecology`, `sociology`.

The scout picks which specialists enter the persona pool based on the
question. `DOMAIN_KEYWORDS` in
`extensions/research-tools/orchestration.ts` maps keywords to specialist
files; word-boundary matching avoids false positives.

### Council / challenger (4)

- `consensus-mapper` — finds where the graph agrees.
- `bias-detector` — flags cognitive and methodological biases.
- `reproducibility-checker` — flags unreproducible claims.
- `meta-analysis-specialist` — cross-study comparison.

### Swarm variants (2)

- `swarm-researcher` — compact persona template consumed when the scout
  spawns many parameterized instances of the generic researcher.
- `swarm-verifier` — compact template for bulk verification.

## Pipeline phases

Enforced by `phase_gate`:

1. **Scout** (round 0) — `scout` runs once; writes `scout-landscape.json`.
2. **Round 1 — Investigate** — each persona writes `append_evidence
   kind=assertion` and `append_persona_memory kind=claim`. No persona reads
   another persona's work in round 1.
3. **Round 2 — Cross-examine** — each persona calls
   `query_evidence_graph(notPersona, round=1)` and writes `support`,
   `contradict`, or `qualify` edges.
4. **Synthesize** — `synthesizer` compresses the graph.
5. **Verify** — `verifier` runs `verify_citations`, `validate_output`.
6. **Review** — `reviewer` grades severity.
7. **Deliver** — `deliver_artifact` is the quality gate; it blocks the
   write to `~/research/<slug>.md` unless the artifact meets thresholds.

## Execution modes

| Mode   | How persona calls run | Default | When |
|--------|-----------------------|---------|------|
| `sync`  | Tier-aware token-bucket queue (`RateLimitedQueue`) | 30 | Default. |
| `batch` | One Anthropic Message Batch; results collected via `zenith batch collect <id>` | 100 | >50 personas or tight rate budgets. |

`MIN_PERSONAS = 10` is hard-coded in `run_swarm`.

## Code-enforced gates

| Gate | Enforces |
|---|---|
| `log_agent_spawn` | Tracks every persona against a budget. No silent runaway. |
| `phase_gate` | Strict phase ordering. No skipping. |
| `deliver_artifact` | Quality threshold before writing to `~/research/`. Failures loop back. |

## Output conventions

- Final reports: `~/research/<slug>.md`
- Working data: `~/.zenith/swarm-work/<slug>/`
- Session logs: `~/.zenith/sessions/`

### File naming within `swarm-work/<slug>/`

- `scout-landscape.json` — scout output
- `manifest.md` — the committed plan
- `evidence.jsonl` — every assertion + support/contradict/qualify edge
- `memory/<persona-id>.jsonl` — per-persona memory
- `batches/<batchId>.json` — batch-mode local record (submitted → ended)
- `events.jsonl` — append-only swarm event timeline
- `quality-gate.json` — pass/fail + scores

Never use generic names like `research.md` or `draft.md`. The slug is
derived once at plan time and every file uses it.

## Delegation rules

- The coordinator plans, delegates, synthesizes, and delivers.
- Use subagents when work is meaningfully decomposable.
- Prefer file-based handoffs (evidence graph, memory) over dumping
  intermediate results back into parent context.
- Subagents may not silently skip assigned tasks. Record skips or merges.
- For critical claims, require at least one adversarial pass (challenger
  roles) after synthesis. Fix fatal issues before delivery or surface
  them explicitly in the artifact.

## Provenance and verification

- Every delivered artifact includes verification metadata in
  `quality-gate.json`.
- Source verification belongs in the verification phase, not in ad-hoc
  edits after delivery.
- Do not say `verified`, `confirmed`, or `checked` unless the underlying
  artifact records what was actually checked and how.
- When a check is missing, mark the work as `blocked`, `unverified`, or
  `inferred`. Do not smooth it over.
