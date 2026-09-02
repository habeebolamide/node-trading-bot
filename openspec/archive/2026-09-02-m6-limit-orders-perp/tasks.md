# Tasks: m6-limit-orders-perp

## 1. Config
- [ ] `ScoringConfig.entryType?: 'MARKET' | 'LIMIT'` (default MARKET)
- [ ] `ScoringConfig.limitPullbackAtr?: number` (default 0.3)
- [ ] `validateScoringConfig` — reject `entryType='LIMIT'` on memecoin (§10 structural)

## 2. Planner
- [ ] `planPerp` — LIMIT branch: entry = close ∓ pullback×ATR by direction
- [ ] Cap: `NO_TRADE('LIMIT_TOO_FAR')` when |entry − close| > 5×ATR (defensive)
- [ ] Tests

## 3. Paper Engine
- [ ] `openPendingPosition` — state=PENDING_ENTRY, no cash committed yet, plannedEntry stored
- [ ] `activatePendingPosition(price)` — transitions PENDING_ENTRY → OPEN, sets
      `openedAtProcessing`, writes a `LIMIT_FILL` fill row
- [ ] `expirePendingPosition` — transitions PENDING_ENTRY → EXPIRED (new terminal state);
      close_reason='LIMIT_EXPIRY'; no P&L
- [ ] `openPositionCount` — counts OPEN + PENDING_ENTRY
- [ ] Tests

## 4. Exit engine
- [ ] `evalTick` — for PENDING_ENTRY positions: return `ACTIVATE_LIMIT` on crossing
      (LONG: price ≤ entry; SHORT: price ≥ entry). Otherwise NONE.
- [ ] Expiry check: `now ≥ createdAt + LIMIT_EXPIRY_MS[style]` → `EXPIRE_LIMIT`
- [ ] Tests

## 5. Style → LIMIT expiry
- [ ] `LIMIT_EXPIRY_MS: Record<TradingStyle, number>` in @tip/trading-agents (from §8:
      scalp 30m / day 6h / swing 24h)

## 6. Outcome + Brain
- [ ] Outcome resolver: skip predictions whose position is `EXPIRED` (LIMIT never filled)
- [ ] Brain feed: unchanged — an unfilled prediction has no outcome, no occurrence

## 7. Wrap-up
- [ ] typecheck + full suite green
- [ ] Archive + summary
