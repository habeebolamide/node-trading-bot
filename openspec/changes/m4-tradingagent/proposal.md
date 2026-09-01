# Change: m4-tradingagent

**Status:** PROPOSED (scoping)
**Milestone:** M4 — Agent Swarm (§30), change 1 of 5
**Implements:** §14 (TradingAgent vs Analysis Agent — the core terminology split), §8 (Agent
Creation, trading style → TF/horizon mapping), §16 versioned config, Task 1 resolution
(versioning axes). §33 rules 16, 24.
**Depends on:** M1 (config, DB), M2 (wallet scoring for context).

## Why

Everything in M4+ hangs off a **TradingAgent** — the user-created strategy entity that owns
config, watches symbols, and eventually places paper trades. And an Analysis Agent's
performance is only meaningful *keyed to* the config version that produced its scores. Both
concepts must exist before we can build the framework (change 2) or the specialized agents
(changes 3–5) that consume them.

This change ships the entities, versioned config, base Agent interface, and CRUD endpoints —
not any specialized Analysis Agent yet.

## What changes

New package **`packages/trading-agents`**:

- **`config.ts`** — `ScoringConfig` schema (per-agent, versioned; §8 field list — riskPercent,
  minRR, maxConcurrentPositions, agentWeights{}, confidenceWeights{}, signalThresholds,
  memecoin-specific stopPct/takeProfitPct/walletExitThreshold/maxPoolShare/batchingWindowMs/
  profitLadder[]).
- **`identity.ts`** — TradingAgent identity types (§8): `{ id, domain, universe, tradingStyle }`
  immutable; separate versioned `ScoringConfig` for everything tunable.
- **`store.ts`** — TradingAgent CRUD: `create`, `list`, `get`, `updateConfig` (writes a NEW
  ScoringConfig row + points the agent at it — never mutates).
- **`agent-interface.ts`** — the base `AnalysisAgent` interface (§6, §7): `analyze(event,
  context) → { direction?, score, confidence, features }` + `AgentContext` (as-of readers,
  wallet score lookup, cluster map, config version).

New API on `apps/api`:
- `POST /trading-agents` — create with `{ name, domain, universe, tradingStyle, config }`.
- `GET /trading-agents` — list.
- `GET /trading-agents/:id` — detail + active config.
- `PATCH /trading-agents/:id/config` — write a new versioned config.

Schema (migration 0006):
- `trading_agent` — `{ id PK, name, domain, universe text[], trading_style, active_config_version, created_at, status }`
- `scoring_config` — append-only versioned rows `{ id, trading_agent_id, version, config jsonb, created_at, active }` (a promoted change writes a new row; unique on (trading_agent_id, version))
- `agent_performance` — placeholder `{ agent_key, agent_version, trading_agent_id, wins, losses, updated_at }` (populated as predictions resolve; empty at M4)
- `brain_agent_memory` — placeholder `{ agent_key, agent_version, domain, standalone_accuracy, updated_at }` (populated in M5)

## What this change does NOT do

- **No specialized Analysis Agents** — that's changes 3–5.
- **No Signal Engine / Feature Aggregator** — that's change 2.
- **No Predictions / Paper Engine** — M6.
- **No frontend** — API endpoints only, per CLAUDE.md.
- `agent_performance` / `brain_agent_memory` are **empty schemas** here — populated when
  M6 outcomes exist and M5 backfills standalone accuracy.

## Sign-off (flag)

- Memecoin `maxConcurrentPositions` fixed at **1** per §32 — enforced in config validation.
- Trading style enum: `scalp | day | swing` (§8 mapping table); style is **immutable** after
  creation (§8 — changing it invalidates the whole TF/horizon basis; that's a new agent).
