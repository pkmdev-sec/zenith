# Changelog

## v0.2.14

MiroFish-inspired swarm architecture. Every research question dispatches 100–500 agents by default.

### Added

- **Swarm pipeline** — 6-phase research flow: Scout → Research Swarm → Cross-Examination → Verification → Build Chain → Quality Gate
- **203 specialist agents** — 4 core (researcher, writer, reviewer, verifier), swarm infra (synthesizer, coordinator, scout, debate-agent), and 195 domain specialists
- **Councils and challengers** — consensus-mapper, debate-agent (triangulator/synthesis/temporal), meta-analysis-specialist for consensus; red-team, bias-detector, reproducibility-checker for adversarial review
- **Code-enforced gates** — `log_agent_spawn` (budget tracking), `phase_gate` (strict phase ordering), `deliver_artifact` (quality threshold before output)
- **Two research tiers** — broad (100–200 agents, default) and expensive (300–500 agents via `/deep-research`)
- **Clean output separation** — final reports at `~/research/<slug>.md`, working data hidden in `~/.zenith/swarm-work/`
- **`--direct` flag** — single-agent bypass for quick answers without the swarm
- **`zenith sync -- --force`** — clean re-sync of agents, skills, and themes

### Skills

Seven slash commands: `/deep-research`, `/swarm-research`, `/export`, `/eli5`, `/session-search`, `/session-log`, `/preview`

### Prompts

Three built-in prompts: `orchestrate` (default routing), `swarm` (broad-tier dispatch), `deepresearch` (expensive-tier dispatch)
