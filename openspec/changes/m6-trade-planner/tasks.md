# Tasks: m6-trade-planner

## 1. Package scaffold
- [ ] `packages/planner` (`@tip/planner`) + root tsconfig reference + vitest alias + npm install

## 2. Market structure (`structure.ts`) — pure
- [ ] `swingPivots(candles, k = 2)` — fractal highs/lows, confirmation both sides
- [ ] `nearestLevels(price, pivots, atr)` — nearest support below / resistance above, collapsing
      levels within 0.25×ATR to the more-touched one
- [ ] config-driven `k`, lookback (100 bars) and collapse factor — MVP defaults, tunable

## 3. Sizing + leverage (`sizing.ts`) — pure, §35
- [ ] `positionSize({ balance, riskPercent, entry, stopLoss })` — **no `confidence` parameter**,
      structurally preventing rule-13/§35 leakage
- [ ] `maxSafeLeverage({ entry, stopLoss, direction, maintenanceMarginRate })`
- [ ] `deriveLeverage()` — min(maxSafe, exchangeMax, config.leverageMax) → requiredMargin
- [ ] `NO_TRADE('CANNOT_SIZE_SAFELY')` when margin exceeds balance — never raise leverage to fit

## 4. Perp planner (`perp.ts`) — Part III §4
- [ ] entry = last close at T (MARKET) or a limit level; SL from pivot → ATR fallback → NO_TRADE
- [ ] TP from the opposing pivot; R:R gate against `config.minRR`
- [ ] planning horizon = the MIDDLE of the style's three (§8)

## 5. Memecoin planner (`memecoin.ts`) — Part II §10
- [ ] MARKET only — a LIMIT request throws `ValidationError`, never a silent downgrade
- [ ] `stopLoss = entry × (1 − stopPct)`; no leverage; no PENDING_ENTRY
- [ ] TP null when `profitLadder` is set; R:R measured against the FIRST rung

## 6. Entry point
- [ ] `planTrade(signal, agentSnapshot, asOfView, balance)` → `PlanResult`, domain-routed
- [ ] `NO_TRADE` is a returned result, never a thrown error

## 7. Tests
- [ ] sizing invariant to confidence (byte-identical across values)
- [ ] leverage derived from stop distance; capped; liquidation never closer than the stop
- [ ] R:R gate fires at exactly `minRR`; vetoes a strong signal
- [ ] infeasible sizing → NO_TRADE, leverage not raised
- [ ] memecoin: MARKET-only, fixed-% stop, TP null under ladder, R:R off the first rung
- [ ] pivots: determinism, both-side confirmation, collapsing, fallback ladder
- [ ] replay stability: identical setup from an identical as-of view

## 8. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary
