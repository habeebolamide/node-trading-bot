# Change: m6-outcome-engine

**Status:** PROPOSED (scoping)
**Milestone:** M6 (change 4 of 6)
**Implements:** §21 Outcome Engine (multi-horizon, T1 anchor, `outcomeResolution`) ·
Task 7 (outcome rules, benchmark/alpha, fees) · §41 (the `updateSetupMemory` call site) ·
§16 (the `recordAgentOutcome` call site) · §33 rules 11, 21, 22

## What's changing

**This is the change that finally puts data into everything M5 built.**

1. **Multi-horizon outcome resolution** (§21) — each prediction is measured at the **style's three
   horizons** plus the **1h cross-style reference horizon** (Task 7). Every horizon is anchored at
   **T1 (entry/fill), not T0 (signal creation)** — §21 is explicit, and it matters concretely for
   LIMIT orders that sit `PENDING_ENTRY` for candles before filling.
2. **Outcome fields** — return, benchmark return, alpha, MFE, MAE, hitTarget, hitInvalidation,
   holding period, and `won` (Task 7: WIN = hit TP before SL within the horizon).
3. **Benchmarks** (Task 7) — perp: the underlying's buy-and-hold over the window; memecoin: SOL
   return over the window. `alpha = directional return − benchmark`.
4. **`outcomeResolution`** — `TICK` for live, `CANDLE_1M_CONSERVATIVE` for seeded (change 6). Both
   populations feed one `BrainSetupMemory`, so §21 requires the difference be visible rather than
   silent.
5. **The Brain wiring** — on resolution, call:
   - `recordSetupOutcome(db, { predictionId, domain, features, closedAt, won, returnPct })`
   - `recordAgentOutcome(db, prediction, contributions)`
   Both were built and tested in M5 and left deliberately unwired; §41 names this handler as their
   call site.

## Why this change is the milestone's payoff

Until it lands, every Historical Edge read returns `INSUFFICIENT`, every Agent Memory read returns
null, and `historicalEvidence` sits at its 0.25 floor. After it lands, the Brain starts learning
and the §32 success criteria become measurable for the first time.

## What this change does NOT do

- **No attribution or calibration reporting** — change 5.
- **No seeding** — change 6 (which reuses this change's resolver with a different resolution mode).
- **No hypothesis pipeline** (§24) — M7, and it uses the higher effective-n ≥ 20 bar.

## Ambiguities to resolve (see `design.md`)

1. **Which horizon defines `won` for the Brain.** §41's `TradeOutcome` takes a single boolean, but
   a prediction resolves at four horizons that can disagree.
2. **How `realizedDirection` is derived for Agent Memory**, which needs a direction that "actually
   paid" independent of what the composite chose.
3. **Whether outcomes are measured from the paper position or from market data.** A position
   closes once; a prediction is measured at four horizons. These give different numbers and the
   plan uses both vocabularies.
