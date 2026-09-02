# Change: m6-trade-planner

**Status:** PROPOSED (scoping)
**Milestone:** M6 — Predictions/Evaluation (change 1 of 6)
**Implements:** §35 Trade Planner (Common) — position sizing & leverage · Part III §4 Perp Trade
Planner · Part II §10 Memecoin Trade Planner (entry + sizing half) · §8 style→ATR-window mapping ·
§33 rules 13, 20, 25

## What's changing

The layer between the Signal Engine and the Paper Engine. The plan keeps these as four distinct
responsibilities and this change builds the second:

```
SIGNAL ENGINE  → "What direction does the evidence favor?"      (M4, done)
TRADE PLANNER  → "Where do we enter, where are we wrong, where is the reward?"   ← THIS
RISK ENGINE    → "Is this trade actually acceptable?"            (M4 Risk Agent, done)
PAPER ENGINE   → "What would have happened if we took it?"       (change 3)
```

New package `@tip/planner`:

1. **Perp planner** (Part III §4) — entry / SL / TP from **market structure**: ATR on the style's
   window (§8: ATR-14 on 5m / 1h / 4h) plus recent support/resistance. TP/SL are never produced
   by an LLM (rule 13).
2. **Memecoin planner** (Part II §10) — deliberately simpler because *the wallets are the thesis*.
   **MARKET entry only**, no entry zone, no LIMIT, no `PENDING_ENTRY` (structurally unreachable
   in this domain, and that is expected rather than missing). Stop is a fixed percentage of fill,
   not an ATR/structure derivation — "neither exists for a token that is minutes old."
3. **Sizing** (§35, domain-generic) — `Position Size = Risk Budget / |Entry − Stop|`, where
   `Risk Budget = Balance × riskPercent` and **riskPercent is a fixed config value, NEVER scaled
   by confidence**.
4. **Leverage as a DERIVED OUTPUT** (§35, perp only) — computed last, from where the stop already
   is: `Max Safe Leverage` (liquidation no closer than the stop) → `min(maxSafe, exchangeMax,
   userMax)` → required margin. Never chosen upfront, never scaled by confidence.
5. **The veto gates** — `NO TRADE` on insufficient R:R (below `minRR`) and on infeasible sizing.
   Leverage is never force-raised to make a trade fit; the trade is rejected instead.

## Why first in M6

Every later change consumes a `TradeSetup`: Predictions record it, the Paper Engine fills it, the
Outcome Engine measures against its TP/SL, and Brain Seeding generates it synthetically. It is
also the most self-contained piece — mostly pure arithmetic over an as-of market view, so it can
be fully unit-tested before anything stateful depends on it.

## What this change does NOT do

- **No real-money execution paths** (rule 20 — absolute for MVP). Not stubs, not
  `TODO: enable later`.
- **No fills.** The planner outputs a *setup*; the Paper Engine decides whether and at what price
  it fills (change 3). Rule 25 lives there, not here.
- **No exit engine.** Part II §10's five-condition exit precedence and the profit ladder are
  runtime position management — change 3.
- **No Judge involvement.** §18's direction override is M7 and cannot reach TP/SL (rule 13).

## Ambiguities to resolve (see `design.md`)

1. **"Recent support/resistance" is never defined numerically** anywhere in the plan — Part III §4
   gives a worked example with concrete levels but no derivation rule.
2. **Which horizon a setup targets** when the style offers three (§8). The R:R gate needs one TP,
   so one horizon must be the planning horizon.
