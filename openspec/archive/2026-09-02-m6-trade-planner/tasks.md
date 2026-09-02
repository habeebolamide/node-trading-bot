# Tasks: m6-trade-planner

`[x]` done — **32 new tests, 427/430 suite green (5 clean runs).**

## 1. Package scaffold
- [x] `packages/planner` (`@tip/planner`) + root tsconfig reference + vitest alias + npm install

## 2. Market structure (`structure.ts`) — pure
- [x] `swingPivots(candles, k = 2)` — fractal highs/lows, confirmation both sides
- [x] `nearestLevels(price, pivots, atr)` — nearest support below / resistance above, collapsing
      levels within 0.25×ATR to the more-touched one
- [x] config-driven `k`, lookback (100 bars) and collapse factor — MVP defaults, tunable

## 3. Sizing + leverage (`sizing.ts`) — pure, §35
- [x] `positionSize({ balance, riskPercent, entry, stopLoss })` — **no `confidence` parameter**,
      structurally preventing rule-13/§35 leakage
- [x] `maxSafeLeverage({ entry, stopLoss, direction, maintenanceMarginRate })`
- [x] `deriveLeverage()` — min(maxSafe, exchangeMax, config.leverageMax) → requiredMargin
- [x] `NO_TRADE('CANNOT_SIZE_SAFELY')` when margin exceeds balance — never raise leverage to fit

## 4. Perp planner (`perp.ts`) — Part III §4
- [x] entry = last close at T (MARKET) or a limit level; SL from pivot → ATR fallback → NO_TRADE
- [x] TP from the opposing pivot; R:R gate against `config.minRR`
- [x] planning horizon = the MIDDLE of the style's three (§8)

## 5. Memecoin planner (`memecoin.ts`) — Part II §10
- [x] MARKET only — a LIMIT request throws `ValidationError`, never a silent downgrade
- [x] `stopLoss = entry × (1 − stopPct)`; no leverage; no PENDING_ENTRY
- [x] TP null when `profitLadder` is set; R:R measured against the FIRST rung

## 6. Entry point
- [x] `planTrade(signal, agentSnapshot, asOfView, balance)` → `PlanResult`, domain-routed
- [x] `NO_TRADE` is a returned result, never a thrown error

## 7. Tests
- [x] sizing invariant to confidence (byte-identical across values)
- [x] leverage derived from stop distance; capped; liquidation never closer than the stop
- [x] R:R gate fires at exactly `minRR`; vetoes a strong signal
- [x] infeasible sizing → NO_TRADE, leverage not raised
- [x] memecoin: MARKET-only, fixed-% stop, TP null under ladder, R:R off the first rung
- [x] pivots: determinism, both-side confirmation, collapsing, fallback ladder
- [x] replay stability: identical setup from an identical as-of view

## 8. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary
