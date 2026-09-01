# Change: m4-signal-engine

**Status:** PROPOSED (scoping)
**Milestone:** M4 — Agent Swarm (§30), change 2 of 5
**Implements:** §9 (Signal Engine — deduplication, correlation, aggregation, prioritization,
expiration), Part II §9 (memecoin composite) / Part III §3 (perp composite), §36 (Signal
Lifecycle state machine), Task 6 (confidence math). §33 rule 13 (LLM does not calculate).
**Depends on:** m4-tradingagent.

## Why

Agents produce individual `{score, confidence, features}` outputs (§7); a **Signal** is what
happens when those get aggregated into a composite → normalized → thresholded → given a
lifecycle. Every agent built in changes 3–5 needs somewhere to *land*. This change ships that
pipe end-to-end: Feature Aggregator → Signal Scoring Engine → Signal row → state machine.

## What changes

`packages/trading-agents` grows:

- **`feature-aggregator.ts`** — collects every agent's output for one symbol/timestamp into a
  single normalized snapshot (§Part III §3 shape). Deduplicates when the same agent fires
  twice within one tick. Keyed by (tradingAgentId, symbol, primaryTfCloseTime).
- **`scoring.ts`** — the **deterministic** composite (§9, Task 6). Per-domain formula reads
  the TradingAgent's `ScoringConfig.agentWeights`, normalizes to [−1, +1], thresholds into
  `{STRONG_LONG | LONG | WEAK_LONG | NEUTRAL | SHORT | STRONG_SHORT}` (perp) or
  `{STRONG_LONG | LONG | WEAK_LONG | NEUTRAL}` (memecoin — long-only, §18 memecoin note).
- **`confidence.ts`** — Task 6 confidence: `0.30·signalStrength + 0.30·agentAgreement +
  0.25·historicalEvidence + 0.15·dataQuality`. `historicalEvidence` is a stub at M4 (returns
  0.5 — "unknown") until BrainSetupMemory lands in M5.
- **`signal-lifecycle.ts`** — the §36 state machine: `ACTIVE → {EXPIRED | INVALIDATED |
  CONSUMED}`. TTL enforcement via the tick monitor (M1 infrastructure). Signal
  hash-fingerprinting so re-arrivals dedupe (§9 correlation).
- **`signal-store.ts`** — Signal persistence with versioned `configVersion` FK (§19 rule 10).

Schema (migration 0007):
- `signal` — `{ id PK, trading_agent_id, symbol, direction, composite_score, confidence,
  state, created_at, expires_at, config_version, evidence jsonb }`
- `signal_feature` — `{ signal_id, agent_key, agent_version, score, confidence, features
  jsonb }` (per-agent contribution — the attribution record §22 will read)

Worker wiring:
- New processor on `SIGNAL_PROCESSING` queue: aggregate → score → persist → transition to
  ACTIVE → publish `signal.created` (or the domain-specific `memecoin.signal.created` /
  `perp.signal.created`).

## What this change does NOT do

- **No Analysis Agents yet** — changes 3–5 register agents whose outputs this consumes.
- **No Predictions** — a Signal is not a Prediction (§9 SIGNAL vs PREDICTION distinction).
  Prediction creation is M6.
- **No Risk Agent veto** — change 5 adds it as the post-aggregation gate.
- **No Judge / LLM** — M7.
- Historical Edge feature returns "unknown" until M5.

## Resolved solo (flag)

- Signal fingerprint = hash of `(tradingAgentId, symbol, direction, primaryTfCloseTime rounded
  to minute)` — enough to dedupe re-arrivals within the same candle without over-collapsing.
- Empty aggregator batch (no agent responded) → **no signal created** (not a NEUTRAL signal).
  Prevents flooding downstream with empty rows.
