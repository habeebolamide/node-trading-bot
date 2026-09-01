# Design: m4-signal-engine

Read §9, Part II §9, Part III §3, §36, Task 6 alongside.

## Flow

```
Agent outputs (AgentOutput events from every agent that fired) → FeatureAggregator per (tradingAgentId, symbol, primaryTfCloseTime)
    → SignalScoringEngine.compose(config, aggregated) → { direction, compositeScore, confidence, evidence }
    → SignalStore.create(...)  → row in `signal` (state=ACTIVE) + one `signal_feature` per contributing agent
    → publish signal.created  (Risk Agent (change 5) subscribes; then Prediction (M6))
    → tick monitor watches TTL / invalidator conditions → transition to EXPIRED / INVALIDATED
    → Trade Planner (M6) transitions to CONSUMED on entry
```

## FeatureAggregator

- **Aggregation window** = the primary-TF candle close (§10 analysis tier). Each agent's
  output arrives asynchronously; the aggregator holds a per-(tradingAgentId, symbol, tfClose)
  bucket that closes on a small debounce (e.g. 500ms after the last output, or on the next
  primary-TF close, whichever comes first).
- **Dedup** — same (agentKey, agentVersion) firing twice inside one bucket → keep the newer.
- Empty bucket at close time → no signal created (no NEUTRAL fabrication).

## SignalScoringEngine (§9, Task 6 — deterministic)

Composite formula per domain:

```
compositeScore = Σ (weight_agent × score_agent) / Σ weight_agent      # renormalized
```

- Only agents present in `config.agentWeights` contribute (absent = disabled per §7).
- Weights sum to 1 after renormalization so two TradingAgents with different rosters produce
  comparable composites (§7 rule).
- `direction` = sign(compositeScore) mapped through `config.signalThresholds`:
    perp: STRONG_LONG / LONG / WEAK_LONG / NEUTRAL / WEAK_SHORT / SHORT / STRONG_SHORT
    memecoin: STRONG_LONG / LONG / WEAK_LONG / NEUTRAL  (long-only, §18 memecoin note)
- Non-directional agents (Regime, Risk, Token Risk) contribute via `direction: NEUTRAL` with
  their enum/verdict carried in the `evidence`; Risk enters ONLY in change 5 as a post-veto,
  not a composite input.

## Confidence (Task 6, weights from ScoringConfig)

```
confidence = 0.30·signalStrength + 0.30·agentAgreement + 0.25·historicalEvidence + 0.15·dataQuality
```

- `signalStrength = |compositeScore|`
- `agentAgreement = 1 − normalized dispersion of agent scores (sign-consistent scores only)`
- `historicalEvidence` = **0.5** stub at M4 (returns "unknown" until M5's `BrainSetupMemory`
  read is wired); Task 6 baseline
- `dataQuality = 1 − penalties` (missing agent, stale feed per M1 FeedMonitor)

Weights come from `config.confidenceWeights` (§8 Added-fields resolution) so promotion changes
version-cleanly.

## Signal state machine (§36)

```
ACTIVE — created, within TTL, not yet acted on
  → EXPIRED       (TTL elapsed, no entry)
  → INVALIDATED   (invalidator fired, or Risk Agent HIGH)
  → CONSUMED      (Trade Planner in M6 turns it into a Prediction)
```

TTL comes from `tradingStyle` per §8 table (scalp 15m / day 4h / swing 1d; memecoin 10m/30m/2h).

## Schema (migration 0007)

```
signal {
  id PK,
  trading_agent_id FK,
  symbol,
  domain,
  direction text,                       -- STRONG_LONG | ... | STRONG_SHORT
  composite_score numeric,
  confidence numeric,
  state text NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | EXPIRED | INVALIDATED | CONSUMED
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  config_version integer NOT NULL,       -- FK into scoring_config.version
  fingerprint text NOT NULL,             -- hash of (tradingAgentId, symbol, direction, tfCloseMinute) — dedup key
  evidence jsonb NOT NULL,               -- { agentAgreement, dataQuality, ... }
  unique (fingerprint)                   -- structural dedup (§9 correlation)
}

signal_feature {
  signal_id FK,
  agent_key text,
  agent_version integer,
  score numeric,
  confidence numeric,
  features jsonb,
  primary key (signal_id, agent_key, agent_version)
}
```

`unique(fingerprint)` = §9 dedup enforced by the DB. Re-arrival of the same "same-candle same
composite" attempt fails on insert → the aggregator/scoring flow silently no-ops.

## Worker wiring

New processor registered on `SIGNAL_PROCESSING` queue: consumes `agent.analysis.completed`
events (published by every agent), routes into aggregator, on aggregator-flush composes +
persists + publishes `signal.created` (+ domain event `memecoin.signal.created` /
`perp.signal.created`).

## Testing

Unit:
- scoring composite: weight renormalization, threshold boundaries, single-agent, all-neutral →
  no signal
- confidence: weights sum, boundary values, historicalEvidence stub at 0.5, dataQuality
  penalties applied
- signal fingerprint: same-candle same-direction dedupes, different-candle doesn't
- state transitions: ACTIVE → EXPIRED at TTL, ACTIVE → INVALIDATED on invalidator event

Integration (live DB):
- End-to-end fake agent outputs → aggregator → scoring → persisted signal + signal_feature
  rows; re-arrival deduped by unique constraint
