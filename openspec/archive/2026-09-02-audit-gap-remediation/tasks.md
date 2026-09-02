# Tasks — audit-gap-remediation

All checked items shipped. Verification: `npm run typecheck` green; full suite 690 pass / 3 skip.

## #1 Live perp analysis tier + Judge wiring  (commit 9db991c)
- [x] `PerpAnalysisTier.onKline` — eligible-agent selection (perp · active · not BLOCKED ·
      universe ∋ symbol · primary-TF == bar), per-agent `SignalEngine`, `forceFlushBucket`.
- [x] Judge tier: `signal.created` → Judge → `judge.evaluation.completed` → override gate.
- [x] Gated on `DEEPSEEK_API_KEY` (no-op without it).

## #2 Tick monitor  (commit 9db991c)
- [x] `processTick` drives `evalTick` (STOP/TP/HORIZON) + `evalPendingTick` (LIMIT fill/expiry).
- [x] Publishes `paper_trade.sl_hit` / `tp_hit`; IN_TRADE → COOLDOWN on close.

## #3 §37 agent lifecycle  (commit 9e37e12)
- [x] State machine + `deriveAgentState` / `refreshAgentState` (sticky COOLDOWN/BLOCKED win).
- [x] `enterCooldown`, `blockAgent`, `unblockAgent`, `tickLifecycle` sweep. Migration 0021.

## #4 dailyLossLimit breaker  (commit 9e37e12)
- [x] `evaluateDailyLoss` — UTC-day realized-P&L accumulator; timed BLOCK to next UTC day.

## #5 Feed-staleness → BLOCKED  (commit 9e37e12)
- [x] `blockAgentsForStaleFeed` (indefinite); `unblockAgentsForRecoveredFeed` clears only
      indefinite blocks (leaves timed daily-loss blocks intact).

## #6 Helius AMM reserves  (this commit)
- [x] `identifyPoolVaults` heuristic (documented — needs real-fixture validation).
- [x] `resolveReservesViaRpc` (`getTokenAccountBalance`, injectable `FetchLike`); `null` → NO_FILL.
- [x] 8 unit tests.

## #7 Atomic token claim (§9a)  (this commit)
- [x] `claimToken` (`onConflictDoNothing` on mint PK), `releaseToken*`, `filterUnclaimed`.
- [x] `resolveContention` — greedy global assignment (score desc, agentRank asc, mint).
- [x] Migration 0022 (`active_token_claim`). 9 tests incl. real concurrent-insert.

## #8 Multi-TF analysis + real Historical Edge (§8, §40.16)  (this commit)
- [x] `ANALYSIS_TFS` / `ANALYSIS_TFS_FOR_PRIMARY` in identity.ts.
- [x] Momentum reads the analysis-TF stack; confidence scaled by cross-TF agreement.
- [x] Perp analysis tier assembles the 8-dim perp fingerprint tuple (rule 24) from agent outputs
      and calls `perpHistoricalEdge` — the stub is gone.

## #9 Fast-lane priority (§11)  (this commit)
- [x] `PRIORITY.FAST` on tick-monitor SL/TP hits.
- [x] `PRIORITY.FAST` on Helius wallet-transaction detection.
- [x] `PRIORITY.FAST` on Judge evaluation + STAND_ASIDE/FLIP override emitters.

## #10 maxPoolShare at fill time (§10)  (this commit)
- [x] `memecoinBuyFill` caps notional to `maxPoolShare × ySol`; flags `poolShareCapped`.
- [x] NO_FILL(`BELOW_MIN_AFTER_CAP`) when the cap pushes below `minNotional`.
- [x] 3 cap unit tests.

---

## Still open (audit #11–#21, lower severity — NOT in this change)
- Telegram alerts (§11) — the original omission; emitter + fast-lane hook.
- Memecoin fill orchestrator (thread reserves + `maxPoolShare` into a live memecoin paper path).
- Pool-vault heuristic validation against real Helius enhanced-tx fixtures.
- Autopsy → hypothesis pipeline live wiring (§24) — perp learning loop.
- Attribution/cost live wiring (§22/§23).
- Dashboard WS deltas for lifecycle-state transitions (§26/§27).
- Historical Edge tier: assemble the real §40.15 Volume feature from a candle buffer (replace the
  documented volume proxy in #8).
