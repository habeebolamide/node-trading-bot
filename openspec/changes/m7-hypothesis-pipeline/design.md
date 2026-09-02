# Design: m7-hypothesis-pipeline

## Schema (migration 0019)

```
learning_hypothesis
  id text PK
  setup_id text NOT NULL
  domain text NOT NULL             -- 'perp' in MVP
  category text NOT NULL           -- failureCategory or successFactor slug
  category_kind text NOT NULL      -- 'FAILURE' | 'SUCCESS'
  evidence_count numeric NOT NULL  -- effective-n at eligibility time
  proposed_change jsonb NOT NULL   -- { agentKey, deltaWeight } | { threshold, delta } etc.
  status text NOT NULL             -- PROPOSED | BACKTEST_PENDING | BACKTEST_PASSED |
                                   --  OOS_PENDING | PROMOTED | REJECTED | DEFERRED_BOOTSTRAP
  backtest_result jsonb            -- HeadlineMetrics-shaped, includes fromConfigVersion, toConfigVersion
  oos_result jsonb                 -- same shape, on the held-out window
  from_config_version integer      -- promoted-from
  to_config_version integer        -- promoted-to (populated on PROMOTION only)
  created_at timestamptz NOT NULL
  resolved_at timestamptz NULL     -- populated on PROMOTED or REJECTED
  index on (status, setup_id)
```

## Aggregation (`aggregate.ts`)

```ts
aggregatePatterns(db, { domain, asOf }): AsyncGenerator<Pattern>
```

For each `setupId`, sums recency-weighted effective-n per (category, categoryKind) across
`trade_autopsy` rows (status='SUCCESS'). Uses `@tip/brain`'s `recencyWeight` + `HALFLIFE_DAYS`
— reuse, not a second implementation. §24: "using the domain's Setup Memory half-life; raw
counts appear nowhere as a gate."

Yields only patterns clearing `effective-n ≥ 20`. Below that, no proposal — quietly no-op.
That's the eligibility bar §24 makes structural, not a runtime check the caller might forget.

## Proposal (`propose.ts`)

Deterministic table, versioned like any other config:

```ts
const CATEGORY_TO_ADJUSTMENT_V1: Record<string, ConfigDiffTemplate> = {
  POSITIONING_MISREAD:        { kind: 'weightDelta', agentKey: 'perp.positioning',   delta: +0.03 },
  MOMENTUM_OVERWEIGHTED:      { kind: 'weightDelta', agentKey: 'perp.momentum',      delta: -0.03 },
  REGIME_SHIFTED_MID_TRADE:   { kind: 'weightDelta', agentKey: 'perp.market_regime', delta: +0.02 },
  FUNDING_UNDERWEIGHTED:      { kind: 'weightDelta', agentKey: 'perp.funding',       delta: +0.03 },
  LIQUIDATION_SIGNAL_MISSED:  { kind: 'weightDelta', agentKey: 'perp.liquidation',   delta: +0.02 },
  MOMENTUM_CONFIRMED_EARLY:   { kind: 'weightDelta', agentKey: 'perp.momentum',      delta: +0.02 },
  REGIME_ALIGNED:             { kind: 'weightDelta', agentKey: 'perp.market_regime', delta: +0.02 },
  // Unknown categories → null (no proposal); extending the table is a code change, review-visible
};
```

Every delta is small — 2–3%. §24's example (10% → 18%) is a large jump that would require
several rounds of promotion; the table starts conservative because a promoted change is hard to
unwind.

`proposeFromPattern(pattern)` → `LearningHypothesis` row shape or null. Renormalization at
promotion time keeps weights summing to 1.

## Backtest + OOS

```ts
runBacktest(db, hypothesis, opts): HeadlineMetrics
runOutOfSample(db, hypothesis, opts): HeadlineMetrics
```

Both reuse M6c5 primitives:
- `walkForwardFolds('perp', opts)` splits the range into train (60d) / test (20d)
- `evaluateFold(...)` reports headline metrics per fold

Backtest = ONE fold, chosen from the last complete train window. OOS = the SAME test window's
metrics computed under the proposed config (a second `evaluateFold` with the proposal applied
in-memory — nothing written yet). "Improvement" = `HeadlineMetrics.accuracy` AND
`HeadlineMetrics.meanAlpha` both up, non-overlapping Wilson intervals (M6c5's
`non-measurable-difference` rule applied at promotion).

**§24 wording:** "improvement" is intentionally strict — an improvement whose Wilson intervals
overlap is not an improvement, per the same "no measurable difference" rule M6c5 uses. This is
the ONLY discipline strong enough to keep a permanent config change honest.

## Promotion (`promote.ts`)

```ts
promoteHypothesis(db, hypothesisId): Promise<{ fromVersion, toVersion }>
```

- Loads the current active `scoring_config` row for the tradingAgent.
- Applies the `proposedChange` producing the new config.
- Calls `createScoringConfig(db, { tradingAgentId, config })` from M4 — the versioned
  append-only insert already exists.
- Updates the hypothesis row to `PROMOTED` with `to_config_version`.

No UPDATE of old config rows (rule 16 verbatim).

## Bootstrap gate

`isBootstrapping(db, { domain, configVersion, ... })` from M6c5 gates promotion. If
bootstrapping, the pipeline runs to `BACKTEST_PASSED` but stops there — status
`DEFERRED_BOOTSTRAP`. Once bootstrap clears, a re-run picks up.

## Testing

- Aggregation: 25 autopsies at same setupId sharing a category → one pattern above the ≥ 20
  floor. Same 25 spread across 8 categories → zero patterns proposed.
- Recency: 20 old + 5 fresh with a 90d perp half-life still might not clear 20 effective if the
  old are decayed enough — the check is against effective, not raw.
- proposeFromPattern: unknown category → null; known category → correct delta.
- Backtest reads only past data (rule 21 via M6c5's own guards).
- OOS reads a HELD-OUT LATER window; the fold generator's disjoint construction proves it.
- Promotion writes a NEW `scoring_config` row, does not touch the old one (rule 16 asserted by
  count).
- Bootstrap gate: promotion attempted while bootstrapping → status DEFERRED_BOOTSTRAP, no new
  scoring_config row.
- LLM never proposes weight numbers: a test greps the module for `deepseek`/`llm` imports and
  asserts absence (structural rule-13 enforcement).
