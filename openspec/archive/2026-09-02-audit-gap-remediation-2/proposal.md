# Change: audit-gap-remediation-2

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (continuation of `2026-09-02-audit-gap-remediation`, items #11–#21)

> **COMPLETED.** Closes the remaining eleven items of the severity-ranked plan re-audit:
> #11 wallet-exit live wiring, #12 Telegram alerts, #13 PENDING_ENTRY verification (plan
> cross-reference fix), #14 maxCorrelatedExposure enforcement, #15 Backtests page,
> #16 Attribution page, #17 LLM cost dashboard, #18 bootstrap-window banner, #19 Smart Money
> radar, #20 top-tokens browse, #21 memecoin invalidator lever (resolved as a documented
> deferral, per CLAUDE.md's do-not list). Also fixes a **live correctness bug** found while
> wiring #11: multiple BullMQ workers on one queue split jobs between them, so the market queue
> (tick monitor vs analysis tier) and the signal-processing queue (Judge ×2 + convergence) were
> each losing a fraction of every event stream — now consolidated behind one dispatcher worker
> per queue, the exact composition `registry.ts` prescribed.
>
> **Verified:** typecheck green; full suite **712 passed / 3 skipped** (live-API keys); vite
> production build green. No real-money paths (rule 20); config versioning intact (rule 16).

## What ships

**#11 — Wallet-exit live wiring (Part II §10 Design 1).**
`packages/paper-engine/src/wallet-exit.ts`: `recordOriginatingWallets` (open-time tracking rows)
+ `processWalletSell` — decrement `current_held_fraction` from the parsed sell, log every partial
into the new `wallet_sell_observation` table, and on accumulator ≥ `walletExitThreshold`
binary-full-close with `exitReason = WALLET_EXIT`, priced at the wallet's own observed execution
(`amountSol / tokenAmount`, §20 detection-lag pricing). §29 idempotency via the unique
(position, wallet, tx_signature) index — the observation insert precedes the decrement in one
transaction, so a redelivered webhook mutates nothing. Migration `0023` adds the table + an
`entry_token_amount` column on `paper_position_originating_wallet` (the §10 "per-wallet in-trade
position tracking" needs token units; fallback `entryUsd / entryPrice`, else pessimistic full
exit). Worker consumer `wallet-exit-monitor.ts` publishes `memecoin.wallet.exit.detected` on the
FAST lane and moves the agent to COOLDOWN. 5 integration tests (partial, idempotent redelivery,
crossing close at -2 P&L, post-close no-op).

**Queue-dispatcher fix (found during #11, applies to #1/#2/#12 wiring).**
Two BullMQ workers on one queue COMPETE — each job reaches exactly one. main.ts now owns ONE
worker per queue fanning out in-process: market queue → tick monitor (first — exits before this
bar's analysis) then analysis tier; wallet-analysis → wallet-exit + BuyDetector; signal-processing
→ Judge + override gate + convergence batcher + Telegram. `createTickHandler`,
`createJudgeTierHandlers`, `createConvergenceEmitter`, `createBuyDetectorHandler` expose handlers;
the `register*` variants remain for single-consumer test processes.

**#12 — Telegram alerts (§11).**
`apps/worker/src/alerts/telegram.ts`: Bot-API sender (5s timeout, never throws) + alert handler.
§11 rules enforced: alert only after the fill/close committed (consumes post-commit events),
fire-and-forget (the send is not awaited — the one documented exception), clean feed (SL hits,
TP hits, wallet-exit closes only; formatter returns null for everything else). Gated on the
long-reserved `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. 4 unit tests.

**#13 — PENDING_ENTRY (§36/§37) — verification + plan fix, no code change needed.**
§36's authoritative signal-state list (ACTIVE/EXPIRED/INVALIDATED/CONSUMED) is implemented
exactly; PENDING_ENTRY is a §37 agent state + a position state, and the tick monitor already
calls `refreshAgentState` on both LIMIT fill (→ IN_TRADE) and expiry (→ IDLE/WATCHING). The
audit item stemmed from plan line ~3652 saying "the signal reverts to WATCHING (Signal
Lifecycle, §36)" — a wrong cross-reference (WATCHING is an agent state); the plan is corrected
in this change.

**#14 — maxCorrelatedExposure (§37, §2114).**
`packages/planner/src/correlation.ts`: Pearson over the last 30 primary-TF returns (read via the
as-of view — rules 21/22 hold in backtest), signed corr ≥ 0.7 joins the bucket, bucket capped at
`maxCorrelatedExposure ×` the candidate's full-risk notional. Enforced in `planPerp` after
sizing (the §2114 enforcement point) → `NO_TRADE(CORRELATED_EXPOSURE_CAP)` (new reason variant).
Insufficient overlapping history buckets the holding pessimistically. `heldPositions` is an
optional planner input — absent/empty passes trivially, exact under one-symbol-per-agent. 8 unit
tests (perfect/inverse/flat corr, cap trip, hedge exemption, raised cap, no-data pessimism).

**#15–#20 — dashboard surfaces (§26/§27, §32, §23, §22).**
New API routes: `/api/backtest/walk-forward` (Task-7 folds + test-window metrics),
`/api/llm/costs` (llm_call_log by caller/day/totals), `/api/smart-money` (latest score per rated
wallet off the append-only log, active cluster run, recent buy/convergence events),
`/api/tokens/top` (BrainTokenMemory browse), `/api/brain/token/:mint` (the Tokens lookup was
wrongly hitting the WALLET brain route — fixed). New pages: **Backtests** (#15, perp-only per
§25), **Attribution** (#16, factor predictive value by tertile with the Wilson-overlap reporting
bar), **Costs tab** on LLM Review (#17), **BootstrapBanner** (#18, rendered on Performance +
Backtests — §32 truth-in-labeling), **Smart Money** radar replacing the placeholder (#19),
**Tokens** top-list + fixed lookup (#20). 5 new API integration tests; vite build green.

**#21 — memecoin invalidator lever (§18): documented deferral.**
CLAUDE.md's do-not list explicitly excludes the Judge from memecoin flows in MVP (near-zero
surface, wasted LLM cost) and the Judge's `canHandle` already refuses memecoin. §18 now carries
an MVP-status note: the lever unlocks together with memecoin autopsy when memecoin gets a
backtest (§24's own trigger). Nothing built, deliberately.

## Deviations / resolved ambiguities

- **#14 "1× a single full-risk position"** — yardstick = the candidate's own §35-sized notional
  (documented in correlation.ts). Correlation is signed (hedges exempt); missing history is
  bucketed pessimistically.
- **#12 entry-fill alerts** — §11 wants fills AND closes on Telegram; no open event exists yet
  (the live prediction→open orchestrator is still the top remaining gap), so the feed carries
  the three close events that exist. Opens join the feed when that path lands.
- **#11 unknown entry size** — a sell from an originator whose entry quantity is untrackable is
  treated as that wallet's full remaining exit (earlier exit, never a fabricated hold).

## Plan sections implemented / corrected

Part II §10 (Design 1 partial-sell detection, observations), §11 (Telegram, clean feed,
fire-and-forget), §36/§37 (cross-reference corrected; lifecycle verified), §2114
(maxCorrelatedExposure), §22/§23/§25/§26/§27/§32 (dashboard surfaces), §18 (MVP-status note).

## Still open after this change

- Live prediction → paper-open orchestrator (the biggest remaining gap: nothing calls
  `openPosition` in the live loop yet — plans are made, positions are opened only in tests).
- Memecoin fill orchestrator (thread reserves + maxPoolShare + token claim + originating-wallet
  recording into a live memecoin open path).
- Pool-vault heuristic validation against real Helius fixtures.
- Autopsy → hypothesis pipeline live wiring; attribution/cost sweeps on a schedule.
- Real §40.15 Volume feature from a candle buffer (replaces the #8 proxy).
