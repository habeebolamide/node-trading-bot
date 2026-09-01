# Change: m3-watchlist

**Status:** PROPOSED (scoping — awaiting review)
**Milestone:** M3 — Smart Money Radar (§30), change 1 of 3
**Implements:** Part II §11 (manual watchlist, MVP), §7 (Helius live watching), §10 (event
architecture), §29 (idempotency). §33 rules 12/17/19.
**Depends on:** M1 (Helius ingest), M2 (wallet scoring — rated filter uses `wallet_score_event`).

## Why

We have scored wallets in the DB, and the Helius webhook receiver already ingests raw activity.
But nothing connects them: adding a wallet is a manual CLI step, the webhook isn't actually
subscribed to *your* wallets, and even if it were, `wallet.transaction.detected` events just
pile up — nothing filters them to rated wallets or emits the memecoin buy signal downstream
depends on. This change wires that watch loop end-to-end so a wallet added via API →
backfilled → scored → live-watched → its buys emit `memecoin.wallet.buy.detected`, all
automatic.

## What changes

New package **`packages/watchlist`**:

- **`store.ts`** — `Watchlist` service over the `wallet` table plus a new
  `watched_wallet` table (add/remove/list/get). Adding a wallet: backfill (reuses M2) → score
  (reuses M2) → mark as watched → reconcile the Helius subscription.
- **`subscription.ts`** — `HeliusSubscriptionManager`: keeps the Helius webhook's watched-address
  list in sync with `watched_wallet`. Uses the existing `HeliusWebhookAdmin` (registerOrUpdate is
  idempotent). Called on every add/remove; also has a `reconcileAll` for boot-time drift fix.
- **`buy-detector.ts`** — subscribes to `wallet.transaction.detected` on the wallet-analysis
  queue. For each transaction: (a) confirm the wallet is watched, (b) if action is `BUY`, look
  up wallet score AS OF the block time (`walletScoreAsOf`, rule 21), (c) if rated → publish
  `memecoin.wallet.buy.detected` with wallet score, mint, amount, timestamps.

New API surface on `apps/api`:

- `POST /wallets` — `{ address, note? }` → validates address → adds to watchlist →
  returns `{ status: 'rated' | 'unrated', score?, tradeCount, backfillMs }` (synchronous;
  backfill runs inline so the caller sees the outcome).
- `GET /wallets` — list watched wallets with current status/score.
- `DELETE /wallets/:address` — unwatch + reconcile subscription.

Schema (migration 0004): `watched_wallet` (`address` PK, `note`, `watched_at`, `unwatched_at`)
— separate from `wallet` because `wallet` is the platform-wide profile (anyone we've *scored*),
`watched_wallet` is the subset actively being monitored (subscription target).

## What this change does NOT do

- No funder clustering (change 2).
- No convergence detection (change 3).
- No auto-discovery of new candidate wallets (post-MVP, Part II §11).
- No frontend UI (M8) — just the REST endpoints the eventual UI will call.
- No coordinated-wallet detection (post-MVP).

## Resolved solo (flag)

- **Backfill runs inline** in `POST /wallets`, not queued. For MVP with a growing roster this
  is fine (a couple minutes worst case, per-wallet); if it grows painful, move to a job with a
  status endpoint later.
- **`GET /wallets` reads the "current" score** via `liveWalletScore`, not `walletScoreAsOf` —
  it's a UI/status read, not a replay/backtest path (the split is exactly what score-log.ts
  exports separately).
- Address validation is basic (base58 + length range); a full Solana pubkey check is later.
