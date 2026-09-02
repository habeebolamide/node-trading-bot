# Design: m5-historical-edge

## The backoff ladder

Part II §8 mandates: exact fingerprint → drop the least-informative feature → widen buckets →
global base rate, stopping at the first rung with `effectiveN ≥ 10`. It does not say which
feature is least informative. **Resolved: ascending composite weight** (Part II §9 / Part III
§3), ties alphabetical. Reusing the plan's own weight ranking avoids inventing a second
informativeness ordering that nothing has validated.

### Memecoin ladder (5 dims → 6 rungs)

| Rung | Dimensions retained | Dropped |
|---|---|---|
| 0 | smart_money, convergence, momentum, token_quality, market_regime | — |
| 1 | smart_money, convergence, momentum, token_quality | market_regime (5%) |
| 2 | smart_money, convergence, momentum | + token_quality (10%) |
| 3 | smart_money, convergence | + momentum (15%) |
| 4 | smart_money | + convergence (20%) |
| 5 | — global base rate | all |

### Perp ladder (8 dims → 9 rungs)

Weights: momentum 20 · open_interest 20 · market_regime 15 · liquidation 15 · funding 10 ·
positioning 10 · volume 5.

**Changed during implementation** (was: give volatility market_regime's 15): `volatility` is the
dimension m5-brain-core *added* to reach the stated 6,561-cell count — the plan's weight table
does not rank it, so assigning it any plan weight was arbitrary. It is ranked **0 and dropped
first**, which gives the ladder a better property: rung 1 onward degrades through exactly the
plan-specified 7-feature set, surrendering nothing the plan actually weighted until the added
dimension is gone.

| Rung | Dropped so far |
|---|---|
| 0 | — |
| 1 | volatility (added dimension, unranked by the plan) |
| 2 | + volume (5) |
| 3 | + funding (10) |
| 4 | + positioning (10, alphabetical tiebreak with funding) |
| 5 | + liquidation (15) |
| 6 | + market_regime (15, alphabetical tiebreak with liquidation) |
| 7 | + momentum (20; open_interest survives — alphabetical tiebreak at 20) |
| 8 | — global base rate |

Dropping a dimension means it is **omitted from the hash input**, not bucketed to MED — a
2-dimension fingerprint must not collide with a 5-dimension one whose other three happen to sit
at MED. `setupFingerprint` therefore takes the retained dimension list explicitly and encodes
the arity in the hashed string.

**Rung rows are materialized on write, not computed on read.** `updateSetupMemory` (change 1)
writes only the exact cell; this change adds a companion write that also upserts each coarser
rung's row for the same occurrence. Alternative considered — aggregate coarser rungs on demand
with a `GROUP BY` over occurrences — rejected: it re-reads the whole occurrence history per
signal, and it makes a read's answer depend on when it ran, which breaks replay reproducibility
(rule 11). Materializing keeps every rung a plain keyed row with identical §41 math.

Cost: one occurrence writes 6 rows (memecoin) / 9 rows (perp) instead of 1. At one memecoin
position at a time (§32) and perp's paper volume, this is negligible.

## Global base rate

Rung N is the domain's own aggregate across every occurrence — win rate of all resolved
predictions in the domain, same recency weighting, same Wilson treatment. Stored as a reserved
`setupId` (`__global__:perp` / `__global__:memecoin`) so it is one more row on the same ladder
rather than a special code path.

## Output contract

```ts
interface HistoricalEdge {
  evidence: 'SUFFICIENT' | 'INSUFFICIENT';
  exactOccurrences: number;      // raw count at rung 0, for the §8 explicit-state object
  observedWinRate: number | null;// rung-0 point estimate — reported, never used as the score
  fallback: string | null;       // human-readable rung description, e.g. "dropped market_regime"
  fallbackWinRate: number | null;
  backoffDepth: number;          // 0 = exact, N = global base rate
  effectiveN: number;
  ciWidth: number | null;
  score: number;                 // signed [-1, +1] contribution
}
```

`evidence` is `SUFFICIENT` only when **rung 0** cleared effective-n 10. A signal answered from
rung 3 reports `INSUFFICIENT` with `fallbackWinRate` populated — which is exactly §8's worked
example, where 7 exact occurrences at 86% must not surface as `86%`.

## Score computation (§40.16 step 4)

```
if no rung has effectiveN ≥ 10 → score 0            // nothing to say
winRate      from the answering rung
ciWidth      = wilsonUpper − wilsonLower
strength     = clamp01(1 − ciWidth)                 // narrow CI ⇒ strong
attenuation  = 0.5 ^ backoffDepth                   // each rung halves the contribution
score        = sign(winRate − 0.5) × min(1, |winRate − 0.5| × 2) × strength × attenuation
```

`attenuation` implements §40.16's "every layer of backoff reduces confidence attributed to this
feature — a global-base-rate fallback contributes near-zero": at the memecoin ladder's global
rung (depth 5) the multiplier is 0.031, at perp's (depth 8) it is 0.004.

The sign convention follows §40.16 exactly: **win rate above 50% amplifies the trade's
direction rather than countering it.** Setup Memory records the outcome of predictions made in
whatever direction the composite chose, so >50% means "setups shaped like this one have been
paying off" — a directionless quality multiplier, not a directional opinion. Documented in the
implementation, because the opposite reading (contrarian) is a plausible misreading that would
silently invert 5% of both composites.

## `historicalEvidence` in confidence (Task 6)

Currently `packages/trading-agents/src/confidence.ts` hardcodes `0.5` with an `M4 stub` comment.
Task 6 defines it as `f(effective-n, Wilson width)`, low when INSUFFICIENT:

```
historicalEvidence = clamp01( sampleTerm × precisionTerm )
sampleTerm    = min(1, effectiveN / 30)     // saturates at 3× the trust floor
precisionTerm = clamp01(1 − ciWidth)
INSUFFICIENT (no rung cleared) → 0.25       // not 0: "we looked and found nothing" is weak
                                            // evidence, not a confidence-destroying fault
```

0.25 rather than 0 is a judgment call: driving the 25%-weighted sub-metric to 0 would cap total
confidence near 0.75 for every signal until the Brain warms up, which would make M6's early
calibration curves unreadable. Noted here rather than buried.

## Wiring into the composite

Historical Edge is a **Feature, not an Agent** (§40 "Features (not Agents)"): no trigger, no
`agentVersion`, no `AgentPerformance`, no `BrainAgentMemory`, no user toggle. It enters through
the Feature Aggregator at its configured weight (5% default, settable to 0). `agentWeights`
already carries a `historical_edge` key slot; this change makes the default config supply it
and the aggregator honour it.

## Point-in-time discipline (rules 11/21/22)

`historicalEdge()` takes `asOf: Date` and filters occurrences to `closed_at <= asOf`. There is
**no** `currentHistoricalEdge()` / `latest()` accessor — same structural enforcement
`@tip/evaluation`'s `AsOfMarketData` already applies to candles. A backtest at T must see only
setups that had already resolved by T; leaking future outcomes into a historical fingerprint is
the single most damaging look-ahead bug available in this system, because it would make the
backtest look brilliant for exactly the wrong reason.

## Testing

- Backoff — stops at the first rung clearing effective-n 10; walks all the way to global when
  nothing clears; `backoffDepth` and `fallback` describe the rung that actually answered.
- Dropped dimension is omitted from the hash, not MED-bucketed (arity collision test).
- §8's worked example reproduced: 7 exact occurrences at 86% reports `INSUFFICIENT` with the
  parent's rate, never a bare 86%.
- Score — sign follows `winRate − 0.5`; narrow CI outscores wide CI at equal win rate; each
  backoff rung halves the contribution; global fallback ≈ 0.
- `historicalEvidence` — 0.25 when nothing clears; rises with effective-n; falls with CI width.
- Point-in-time — an occurrence closed after `asOf` cannot change the answer.
- Empty Brain (the M5 reality until M6) — every read returns INSUFFICIENT, score 0, and the
  composite is numerically unchanged from its M4 behaviour.
