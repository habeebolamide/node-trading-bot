# Design: m4-tradingagent

Read §14, §8, §16 alongside.

## Terminology (do not confuse — §14 is explicit)

- **TradingAgent** = user-created entity (name, domain, universe, tradingStyle, config)
- **AnalysisAgent** = specialized reasoner (§6 interface); many per TradingAgent

Every export in this package spells one or the other out. Never `Agent` unqualified.

## TradingAgent identity (immutable per §8/Task 1)

```
{ id (uuid), name, domain: 'perp'|'memecoin', universe: string[], tradingStyle: 'scalp'|'day'|'swing' }
```

- `domain` and `tradingStyle` immutable after create — changing tradingStyle invalidates the
  whole TF/horizon basis (§8), so we treat that as "make a new agent."
- `universe` = symbols (perp) or chain=`solana` (memecoin, single-chain in MVP).

## ScoringConfig (append-only, versioned per §16)

```
scoring_config {
  id, trading_agent_id, version, config jsonb, created_at, active boolean
  unique (trading_agent_id, version)
}
trading_agent.active_config_version = FK into that.
```

`config` shape (§8 schema):
```
{
  riskPercent, minRR, maxConcurrentPositions, maxCorrelatedExposure, dailyLossLimit,
  leverageMax?,           // perp only
  agentWeights: { [agentKey]: number },   // §7 — absent key = disabled
  confidenceWeights: { signalStrength, agentAgreement, historicalEvidence, dataQuality },
  signalThresholds: { strongLong, long, weakLong, weakShort?, short?, strongShort? },
  // memecoin-only
  stopPct?, takeProfitPct?, walletExitThreshold?, maxPoolShare?, batchingWindowMs?,
  profitLadder?: [{ at, sellFraction, postTakeAction }]
}
```

Config validation:
- `maxConcurrentPositions = 1` for memecoin (§32 domain rule; enforced).
- Weights sum need not equal 1 — renormalized at scoring time (change 2).
- Ladder cumulative `sellFraction ≤ 1.0` (Part II §10 write-time check).
- `minRR ≥ 0`, `riskPercent ∈ (0, 1)`, `dailyLossLimit ≥ 0`.

`updateConfig(id, newConfig)` = insert new row with `version = max+1`, flip agent's
`active_config_version` in one txn. The prior row stays (`active` may become false but is
never mutated). Every downstream Prediction/Signal FKs the specific version that produced it
(§19).

## AnalysisAgent interface (§6/§7)

```ts
export type Trigger = 'CADENCE' | 'EVENT' | 'CONDITIONAL';

export interface AgentOutput {
  agent: string;                          // agentKey — 'perp.momentum', 'memecoin.smart_money' ...
  agentVersion: number;                   // integer, per Task 1
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  score: number;                          // [-1, +1]
  confidence: number;                     // [0, 1]
  features: Record<string, unknown>;
  skipped?: boolean;                      // for CONDITIONAL dead-candle skips
}

export interface AgentContext {
  db: Db;
  now: Date;                              // deterministic clock in replay
  tradingAgentId: string;
  configVersion: number;
  domain: 'perp' | 'memecoin';
  primaryTf: Timeframe;
  // As-of readers preserve rule 21 in every path.
  walletScoreAsOf: (walletId: string, at: Date) => Promise<WalletScoreRow | null>;
  activeClusterMap: () => Promise<Map<string, string>>;
}

export interface AnalysisAgent {
  readonly key: string;                   // 'perp.momentum'
  readonly version: number;
  readonly trigger: Trigger;
  canHandle(event: DomainEvent): boolean;
  analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null>;
}
```

- Non-directional agents (Regime, Risk, Token Risk) special-case `direction: 'NEUTRAL'` and
  carry their enum/verdict in `features`.
- `agentVersion` bump policy (Task 1): only when behavior changes (formula tweak, new field
  read). A refactor without a behavioral change does NOT bump.

## AgentPerformance / BrainAgentMemory (skeleton, populated later)

Two tables, both keyed `(agent_key, agent_version[, trading_agent_id])`:

- `agent_performance` — per-TradingAgent per-agent accuracy (populated as M6 Predictions
  resolve).
- `brain_agent_memory` — domain-wide standalone counterfactual accuracy (§16, populated in M5).

Both created empty at M4 so the framework has row-shapes to write to when the time comes.

## Schema (migration 0006)

Five tables. `trading_agent`, `scoring_config`, `agent_performance`, `brain_agent_memory`,
plus a `signal` **placeholder** stub (0 columns beyond PK) that change 2 replaces with the
real definition — kept minimal so change 2 can add a migration without a conflict with a
placeholder shape.

Actually — simpler: no `signal` placeholder here. Change 2 adds it fresh in migration 0007.

## API (apps/api)

- `POST /trading-agents` — validate → insert TradingAgent + first ScoringConfig (v1) → return
  full row.
- `GET /trading-agents` — list active agents with their current status.
- `GET /trading-agents/:id` — detail incl. active config JSON.
- `PATCH /trading-agents/:id/config` — validate → insert new ScoringConfig version → flip
  `active_config_version` → return.

Same ambient security posture as `/wallets` (no auth yet — internal ops surface until dashboard).

## Testing

Unit:
- Config validation: memecoin `maxConcurrentPositions=1` enforced; profit-ladder cumulative
  ≤ 1.0; minRR/riskPercent bounds.
- `updateConfig` writes a new row + flips active atomically (fake db).

Integration (live DB):
- POST → GET round-trip. PATCH creates v2, GET returns v2, `scoring_config` has both rows.

API (supertest):
- POST 201 / 400 on bad body; GET list + detail; PATCH updates config, returns new active version.
