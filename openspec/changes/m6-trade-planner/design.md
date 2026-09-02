# Design: m6-trade-planner

## Package

`packages/planner` → `@tip/planner`. Depends on `@tip/domain`, `@tip/database`,
`@tip/trading-agents` (for `ScoringConfig` + `Domain`/`TradingStyle`), `@tip/evaluation` (for the
as-of market view). Does NOT depend on `@tip/agents` or `@tip/brain` — the planner consumes a
finished Signal, never re-derives one.

Justification for a new package rather than growing an existing one: it is a distinct layer the
plan names explicitly (Part III §4's four-box diagram), and it is the boundary the Paper Engine
consumes. Folding it into `@tip/trading-agents` would put trade construction inside the package
that owns signal *generation*, which is the conflation Part III §4 warns against.

## Output contract

```ts
type PlanResult =
  | { kind: 'TRADE'; setup: TradeSetup }
  | { kind: 'NO_TRADE'; reason: NoTradeReason; detail: string };

type NoTradeReason =
  | 'INSUFFICIENT_RR'          // below ScoringConfig.minRR (Part III §4)
  | 'CANNOT_SIZE_SAFELY'       // §35 — margin exceeds account even at min sensible leverage
  | 'NO_STOP_DERIVABLE'        // perp: ATR/structure unavailable at T
  | 'STALE_OR_MISSING_DATA';   // as-of view has no usable price at T

interface TradeSetup {
  symbol: string; domain: Domain; direction: 'LONG' | 'SHORT';
  entryType: 'MARKET' | 'LIMIT';       // memecoin is always MARKET (Part II §10)
  entry: number; stopLoss: number; takeProfit: number | null;  // TP null when a ladder is configured
  riskReward: number;
  positionSize: number; notional: number;
  leverage: number | null; requiredMargin: number | null;      // perp only
  horizon: Horizon;                    // the planning horizon — see below
  plannedAt: Date;                     // T0
  configVersion: number;               // rule 16 — carried into the Prediction
}
```

`NO_TRADE` is a **first-class result, not an exception**. A directionally-correct signal that
fails the R:R gate is a normal, expected outcome (Part III §4 says so explicitly), and modelling
it as a thrown error would make the common case look like a fault in logs and metrics.

## Ambiguity 1 — "recent support/resistance"

Part III §4's worked example cites `Recent support: $64,850` against `BTC $65,789` with
`ATR: $620`, but never says how those levels are found. Nothing else in the plan defines it.

**Resolution: swing-pivot levels on the style's ATR timeframe.** A swing high/low is a bar whose
high (low) exceeds that of the `k` bars either side (`k = 2`, a standard fractal), taken over the
last 100 bars of the ATR-window timeframe (§8: 5m / 1h / 4h by style). Nearest level *above* the
entry is resistance, nearest *below* is support. Levels within 0.25×ATR of each other collapse to
the stronger (more touches).

Why this over the alternatives:
- **vs. rolling min/max** — a 100-bar extreme is a single point that a wick can set; pivots
  require confirmation on both sides, which is what "support" is supposed to mean.
- **vs. volume profile / order-block clustering** — needs data M1 does not ingest (no per-price
  volume), and would be a provider requirement the plan never states.
- Deterministic and computable from `market_candle` alone, so it replays identically (rule 11) —
  which Brain Seeding (change 6) depends on absolutely.

Both the derivation and `k` live in config so they are tunable without a code change, per the
plan's general rule for MVP-default numbers.

**Fallback ordering when no pivot is available** (a fresh symbol, a thin history):
`swing pivot → ATR multiple (entry ∓ 1.5×ATR) → NO_TRADE('NO_STOP_DERIVABLE')`. The ATR fallback
is what the plan's own example implies (a stop roughly 1.5 ATR away) and keeps a usable stop for
symbols whose structure is genuinely flat.

## Ambiguity 2 — which horizon a setup targets

§8 gives each style **three** horizons (e.g. day: 1h · 4h · EOD). The R:R gate needs exactly one
TP, so one must be the planning horizon, while all three remain the *evaluation* set (Task 7:
"the style's three horizons are the evaluation set").

**Resolution: the MIDDLE horizon is the planning horizon.** §8 already uses "the middle of each
band" as its selection rule for Primary TF, so reusing it is consistent rather than novel. The
setup records `horizon` explicitly, and the Outcome Engine (change 4) still measures all three
plus the 1h reference — planning at one horizon and evaluating at three is exactly what Task 7
describes.

## Sizing and leverage — the ordering is the point (§35)

```
riskBudget   = balance × riskPercent          // config; NEVER a function of confidence
stopDistance = |entry − stopLoss|
positionSize = riskBudget / stopDistance
notional     = positionSize × entry
                     ↓  perp only, and ONLY here — never earlier
maxSafeLev   = highest leverage where liquidation is no closer to entry than the stop
allowedLev   = min(maxSafeLev, exchangeMax, config.leverageMax)
requiredMargin = notional / allowedLev
   → if requiredMargin > balance  →  NO_TRADE('CANNOT_SIZE_SAFELY')
```

§35 calls picking leverage first and validating after "the exact anti-pattern to avoid," and is
emphatic that **confidence affects nothing about size, margin or leverage** — it only ever affects
the Judge's own behaviour (§18). The implementation enforces this structurally: `confidence` is
not a parameter of the sizing function at all, so it cannot leak in. A test asserts that two
setups differing only in confidence produce byte-identical sizing.

Liquidation price uses Bybit's maintenance-margin formula for linear perps; the maintenance rate
is a config value rather than hardcoded, since it is exchange policy and changes without notice.

## Memecoin specifics (Part II §10)

- `entryType` is always `MARKET`; a LIMIT request is a `ValidationError`, not a silent downgrade.
- `stopLoss = fill × (1 − stopPct)`, so `|entry − stop| = entry × stopPct` and §35's formula is
  used unchanged.
- `takeProfit` is **null when `profitLadder` is configured** — Part II §10 states they are
  mutually exclusive. `validateScoringConfig` (M4) already rejects both together; the planner
  asserts the invariant rather than re-deriving it.
- R:R for a laddered setup is computed against the **first rung**, since that is the first reward
  the position can actually realize. Documented inline because computing it against the last rung
  would flatter every laddered setup past the gate.
- No leverage (spot), so `leverage`/`requiredMargin` are null.

## Testing

CLAUDE.md's mandatory list names this change directly — "Trade Planner sizing/leverage:
derived-not-chosen ordering, R:R gate, NO TRADE on infeasible sizing":

- Sizing is invariant to confidence (byte-identical output across confidence values).
- Leverage derives from stop distance: a wider stop yields lower max-safe leverage; leverage never
  exceeds `config.leverageMax` or the exchange cap.
- Liquidation never sits closer to entry than the stop, across a sweep of stop distances.
- `NO_TRADE('INSUFFICIENT_RR')` fires at exactly `minRR`, and a directionally-strong signal is
  vetoed by it.
- `NO_TRADE('CANNOT_SIZE_SAFELY')` when required margin exceeds balance; leverage is NOT raised to
  make it fit.
- Memecoin: MARKET only (LIMIT throws); stop is exactly `fill × (1 − stopPct)`; TP null under a
  ladder; R:R uses the first rung.
- Pivot detection: deterministic, confirmation on both sides, level collapsing, and the
  documented fallback ordering down to `NO_TRADE`.
- Replay stability: the same as-of view produces the identical setup twice (rule 11).
