# Changelog

## Unreleased — MiroFish refactor

The "100–500 agents per question" claim was a façade: the old runtime spun
up one-shot parallel calls against 203 specialist files, most of which were
stubs. This release replaces that with a real MiroFish-style pipeline —
fewer files, but every persona now runs with memory and a shared evidence
graph across multiple rounds.

### Single model

- Pinned to **Anthropic `claude-opus-4-6`** everywhere. Enforced in:
  `src/model/catalog.ts`, `src/pi/settings.ts`, `.zenith/settings.json`,
  `~/.zenith/agent/settings.json`, and by stripping `ANTHROPIC_MODEL`,
  `ANTHROPIC_MAX_TOKENS`, `ANTHROPIC_SMALL_FAST_MODEL`, and `CLAUDE_MODEL`
  env vars in `src/pi/runtime.ts::buildPiEnv`.

### Agent roster — 203 → 28 real

- Deleted 175 unused specialist stubs.
- Curated roster: 9 infra + 13 domain specialists + 4 council/challenger +
  2 swarm variants = 28 agents, each with a real system prompt and the
  MiroFish round protocol.
- `DOMAIN_KEYWORDS` in `orchestration.ts` reduced 35 → 23 keywords, all
  mapping to the 13 specialist files that actually exist. Word-boundary
  matching avoids false positives.

### Persona memory + shared evidence graph

- `extensions/research-tools/memory.ts` — per-persona JSONL at
  `~/.zenith/swarm-work/<slug>/memory/<persona-id>.jsonl`. Tools:
  `read_persona_memory`, `append_persona_memory`. Retractions are
  first-class entries, not deletions.
- `extensions/research-tools/evidence-graph.ts` — shared JSONL at
  `~/.zenith/swarm-work/<slug>/evidence.jsonl`. Deterministic claim IDs
  (`c_<sha256[:8]>` of `persona|claim|round`). Kinds:
  `assertion | support | contradict | qualify`. `disputedClaimIds()`
  returns claims with both support and contradict edges.

### Rate-limit queue (sync mode)

- `extensions/research-tools/rate-limit-queue.ts` — tier-aware token-bucket
  limiter. Tier read from `ANTHROPIC_TIER`. Concurrency capped at 8 regardless
  of tier to avoid 429 storms.

### Anthropic Message Batches (batch mode)

- `extensions/research-tools/batch-runner.ts` — zero-dep client against
  `/v1/messages/batches`. Raw HTTP via global `fetch`. 50% discount,
  100,000-request cap, bypasses RPM limits. Local state at
  `~/.zenith/swarm-work/<slug>/batches/<batchId>.json`.
- **New CLI:** `zenith batch list` / `status <id>` / `collect <id>`.
  `collect` stitches succeeded results back into the evidence graph
  (`assertion`) and per-persona memory (`claim`); counts errored, canceled,
  expired, and orphaned custom_ids.

### Orchestration

- `run_swarm` grew `personas[]`, `rounds`, `executionMode` fields.
  `MIN_PERSONAS = 10`. Defaults: 30 (sync), 100 (batch).
- `prompts/orchestrate.md` rewritten around the MiroFish pattern: Scout
  → Round 1 (investigate, assert) → Round 2 (cross-examine:
  support / contradict / qualify) → Synthesize → Verify → Review → Deliver.

### UI

- Reverted the live aurora header; static ASCII logo only.

### Build / packaging

- `tsconfig.build.json` now includes both `src/**/*.ts` and
  `extensions/**/*.ts`. Dist layout shifts to `dist/src/` + `dist/extensions/`.
- `src/system/app-root.ts` walks up from `import.meta.url` to find the
  package root; used in `src/cli.ts` to stay layout-agnostic.
- `bin/zenith.js` points to `dist/src/index.js`.
- `src/ui/terminal.ts` owns the ASCII banner directly; `tests/logo.test.ts`
  keeps it locked to `logo.mjs`.

### Delivery gates (verify receipt + quality-gate.json)

Post-mortem of the autogenesis-protocol-agp run revealed that
`deliver_artifact` was publishing reports without `verify_citations` ever
running during the swarm — the only checks that fired were the in-process
structural ones, which cannot detect broken URLs. Tightening:

- `verify_citations` now accepts an optional `slug`. When provided with a
  PASS verdict, it appends a `verify_citations_passed` event to
  `swarm-work/<slug>/events.jsonl`. The `hg*` swarm-dir resolver in
  `extensions/research-tools/hallucination-guard.ts` intentionally skips
  emission for non-existent swarms so out-of-band auditor invocations still
  work.
- `deliver_artifact` requires that event to exist for the slug before it
  will publish. Structural check runs first (most specific failure),
  receipt check runs second.
- Every `deliver_artifact` call — success or block — now writes
  `swarm-work/<slug>/quality-gate.json` with: citation counts, verify
  metadata (urlsChecked / urlsLive / minorIssues), evidence-graph stats
  (total claims, round-1 assertions, round-2 support/contradict/qualify),
  disputed claim IDs, and a soft-warning list. Shallow round-2
  cross-examination (0 contradicts across 10+ round-1 assertions) is
  flagged as a warning, not a block: genuine consensus is legitimate, but
  humans should see the ratio.
- `prompts/orchestrate.md` now requires challenger personas to produce at
  least 1 `contradict` per 5 round-1 assertions, or explicitly log
  `qualify` edges beginning `"no contradictable claim found after review:"`
  with reasoning. Silent consensus is not accepted by the prompt.

### Tests

118 → 149 passing. Added `tests/batch-cli.test.ts` (13), `tests/logo.test.ts` (2), `tests/top-level-commands.test.ts` (1), `tests/delivery-contract.test.ts` (3), new quality-gate + verify-emission tests in `tests/orchestration-gates.test.ts` (3) and `tests/hallucination-guard.test.ts` (4), plus `buildDispatchPlan` tests (5). Existing suites: memory, evidence-graph, rate-limit-queue, batch-runner, orchestration gates, pipeline paths, classify intent, pi settings/runtime, and more.

### Verification

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass.

---

## v0.2.14 (pre-refactor) — retained for reference

See commit `6224806` and prior for the pre-MiroFish pipeline.
