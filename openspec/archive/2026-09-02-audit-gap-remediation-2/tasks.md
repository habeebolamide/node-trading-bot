# Tasks — audit-gap-remediation-2 (#11–#21)

All checked items shipped in one commit. Verification: typecheck green; full suite 712 pass /
3 skip; vite build green.

## #11 Wallet-exit live wiring (Part II §10 Design 1)
- [x] Migration 0023: `wallet_sell_observation` + `entry_token_amount` on originating-wallet.
- [x] `recordOriginatingWallets` (idempotent open-time tracking rows).
- [x] `processWalletSell` — fraction-of-entry decrement, observation log, binary WALLET_EXIT
      close at the wallet's observed sell price; §29 idempotency by unique index.
- [x] Worker consumer → `memecoin.wallet.exit.detected` (FAST) + COOLDOWN.
- [x] 5 integration tests (incl. redelivered-webhook no-op and P&L of the close).

## Queue-dispatcher fix (correctness bug found during #11)
- [x] ONE worker per queue in main.ts; handlers exposed via `create*Handler` factories.
- [x] Market queue: tick monitor runs before the analysis tier on each bar.
- [x] Signal-processing queue: Judge + gate + convergence + Telegram composed.
- [x] Wallet-analysis queue: wallet-exit + BuyDetector composed.

## #12 Telegram alerts (§11)
- [x] Sender with 5s timeout; never throws; fire-and-forget (documented exception).
- [x] Clean feed: SL / TP / wallet-exit only; formatter returns null otherwise.
- [x] Gated on TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. 4 unit tests.

## #13 PENDING_ENTRY (§36/§37)
- [x] Verified: §36 four-state list exact; tick monitor refreshes agent state on fill + expiry.
- [x] Plan fix: §3652 cross-reference corrected (WATCHING/PENDING_ENTRY are §37 agent states).

## #14 maxCorrelatedExposure (§37/§2114)
- [x] `correlation.ts`: Pearson over 30 primary-TF returns via the as-of view (rules 21/22).
- [x] Signed ≥0.7 buckets; cap = maxCorrelatedExposure × candidate notional; pessimistic on
      missing history; NO_TRADE(CORRELATED_EXPOSURE_CAP) new reason variant.
- [x] `heldPositions` optional input threaded through planTrade → planPerp. 8 unit tests.

## #15 Backtests page (§26)
- [x] `/api/backtest/walk-forward` (Task-7 folds, test-window metrics, perp-only 400 otherwise).
- [x] Backtests page: agent picker, window picker, fold table, bootstrap banner.

## #16 Attribution page (§22/§26)
- [x] Attribution page over `/api/metrics/factor`: six perp factors × tertile stats, Wilson
      intervals, measurable-difference badge.

## #17 LLM cost dashboard (§23/§26)
- [x] `/api/llm/costs` (totals, by caller, by day). Costs tab on LLM Review.

## #18 Bootstrap banner (§32)
- [x] `BootstrapBanner` component; rendered on Performance + Backtests when n < 30.

## #19 Smart Money radar (§26/§27)
- [x] `/api/smart-money`; page: top-scored wallets (latest append-only read), active cluster
      run + membership, recent buys, recent convergences. Placeholder gone.

## #20 Tokens browse (§26)
- [x] `/api/tokens/top` + `/api/brain/token/:mint` (lookup was hitting the WALLET route — fixed).
- [x] Tokens page: top-list (click-to-lookup) + point lookup.

## #21 Memecoin invalidator lever (§18)
- [x] Resolved as documented deferral (CLAUDE.md do-not list; Judge canHandle already refuses
      memecoin). §18 MVP-status note added; unlocks with memecoin autopsy/backtest (§24).

## API test additions
- [x] 5 new dashboard.test.ts cases covering every new route.
