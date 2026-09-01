# Design: m3-watchlist

Read Part II §11 (manual watchlist), §7 (Helius live), and §10 alongside.

## Flow

```
POST /wallets { address }
    → Watchlist.add(address)
        → HeliusRestClient (backfill wallet history — reuses M2 backfillWallet)
        → scoreAllWallets (reuses M2 — universe recompute; append WalletScoreEvent if rated)
        → insert watched_wallet row
        → HeliusSubscriptionManager.reconcile() — update Helius webhook's account list
    → response { status: 'rated'|'unrated', score?, tradeCount, backfillMs }

Helius webhook POST → apps/api (existing) → helius.webhook.received on blockchain-ingestion
    → helius/ingest.ts consumer (existing) → parses, persists, emits wallet.transaction.detected

BuyDetector subscribes to wallet.transaction.detected on wallet-analysis queue:
    if not in watched_wallet → drop
    if action !== 'BUY'       → drop
    score = walletScoreAsOf(wallet, blockTime)         # point-in-time, rule 21
    if score === null (UNRATED at that time) → drop
    → publish memecoin.wallet.buy.detected {
        wallet, walletScore: score.score, mint, amountSol, tokenAmount,
        blockTime, detectedAt (processing time)
      }
```

## Schema (migration 0004)

```
watched_wallet {
  address text primary key,              -- also FK'able to wallet.address
  note text,                             -- optional label ("Trader Alice")
  watched_at timestamptz not null default now(),
  unwatched_at timestamptz               -- soft-delete: null = actively watched
}
```

Why separate from `wallet`: `wallet` is anyone we've backfilled + scored (platform-wide profile,
shared Brain fact §15). `watched_wallet` is the operator's chosen subscription set — same
wallet could later be "watched → unwatched → re-watched" and we want that history queryable, so
soft-delete via `unwatched_at`. Watched-active = `unwatched_at IS NULL`.

## HeliusSubscriptionManager (subscription.ts)

Keeps the Helius webhook's `accountAddresses` list in sync with active watched wallets. On
add/remove:

```
active = SELECT address FROM watched_wallet WHERE unwatched_at IS NULL
HeliusWebhookAdmin.registerOrUpdate({
  webhookURL: config.HELIUS_WEBHOOK_URL,   -- NEW env var (public URL of /webhooks/helius)
  accountAddresses: active,
  transactionTypes: ['SWAP'],
  webhookType: 'enhanced',
  authHeader: config.HELIUS_WEBHOOK_SECRET,
})
```

`registerOrUpdate` (m1-helius-adapter webhook admin, already built) matches by URL — first call
creates, subsequent calls update in place. `HELIUS_WEBHOOK_URL` becomes an optional config var
(loud fail if watchlist add is called without it configured). `reconcileAll()` on worker boot
resyncs so a manual admin change doesn't drift.

**Free-tier cap (§7 caveat):** Helius free tier caps a webhook at 100 addresses. If
`active.length > 100` the manager throws with a clear message — split-across-multiple-webhooks
is a later refinement, not needed at MVP scale.

## BuyDetector (buy-detector.ts)

A queue consumer registered on `wallet-analysis`. Idempotency-wrapped like every other consumer.
Reuses the wallet-analysis queue since that's where `wallet.transaction.detected` already lands
(the memecoin-signal queue is downstream, populated by what we publish here).

The rated-at-block-time check uses `walletScoreAsOf(wallet, blockTime)` — this is exactly the
rule-21 discipline: a wallet that's only rated in 2026 must not retroactively make 2024 buys
look like smart-money buys. If it was UNRATED at the block time, we drop.

## apps/api endpoints

- `POST /wallets` — validated payload, calls `Watchlist.add(address, note?)`, returns the
  outcome synchronously. On failure (bad address, Helius error, already watched) → 4xx with a
  clear error code.
- `GET /wallets` — returns the active list with `{ address, note, watchedAt, status, score,
  tradeCount, lastScoredAt }` per row.
- `DELETE /wallets/:address` — sets `unwatched_at = now()`, reconciles subscription.

All new routes registered in `createApp`; deps (Watchlist service) injected the same way
`db`/`bus`/`redis` are.

## Wiring

`apps/worker/main.ts`: register `BuyDetector` in the queue processor registry (change 3 will
subscribe to `memecoin.wallet.buy.detected` in turn); on boot call
`HeliusSubscriptionManager.reconcileAll()` so the webhook always reflects the DB truth.

`apps/api/main.ts`: construct `Watchlist` and pass to `createApp` deps; expose new endpoints.

## Testing

Unit (fake HeliusRestClient / fake webhook admin / in-memory DB):
- `Watchlist.add`: backfills, scores, inserts row, calls `reconcile`. Re-add of existing wallet
  is idempotent (updates note, resurrects if soft-deleted).
- `HeliusSubscriptionManager`: builds correct address list from active rows; throws on >100.
- `BuyDetector`: drops non-watched, drops non-BUY, drops UNRATED-at-T, emits with correct payload
  for rated buys.

Integration (live Postgres):
- End-to-end add → row in `watched_wallet`, `wallet` scored, `wallet_score_event` appended,
  `walletScoreAsOf(wallet, now)` returns the score.
- BuyDetector against a real `wallet.transaction.detected` event on the wallet-analysis queue →
  a `memecoin.wallet.buy.detected` lands on the memecoin-signal queue.

API (supertest):
- `POST /wallets` 201 on new, 200 on re-add, 400 on bad address.
- `GET /wallets` returns the active list.
- `DELETE /wallets/:address` 204 + subsequent `GET` doesn't include it.
