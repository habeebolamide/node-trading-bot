# Design: m1-helius-adapter

References the plan by section. Read Part II §7, §4, and §10 (Helius caveat) alongside.

## Flow

```
Helius webhook → apps/api POST /webhooks/helius (auth, change 1)
              → enqueue helius.webhook.received {payload: raw enhanced-tx array} on blockchain-ingestion
              → worker: registerHeliusIngestion consumer
                   parse.ts (pure)  → NormalizedWalletTx[]
                   persist (tx, onConflictDoNothing on tx_hash) → returns NEW ones only
                   for each NEW: bus.publish wallet.transaction.detected  (+ token.activity.detected on first mint sight)
                   monitor.heartbeat('helius.wallet_webhook')
```

The consumer uses `withIdempotency(event.id)` so a re-delivered webhook batch is skipped
wholesale; within it, `tx_hash` unique dedupes at the transaction grain so a *different*
delivery of overlapping txs still can't double-insert (§29). Events are published **after** the
idempotency transaction commits, and only for rows that were actually newly inserted (the insert
`.returning()` tells us which), so no spurious `wallet.transaction.detected` for a tx we already
had.

## parse.ts (the tested core)

Pure `parseHeliusWebhook(payload: unknown): NormalizedWalletTx[]`. Rules:

- Accept an array of enhanced txs (webhook delivers an array); ignore non-arrays → `[]`.
- Per tx: only `type === 'SWAP'` is handled in M1; else skip.
- `wallet = feePayer`.
- Candidate token transfers = `tokenTransfers` where the wallet is `fromUserAccount` or
  `toUserAccount` and `mint !== WSOL`. Pick the largest `|tokenAmount|` (routing produces dust
  hops; the real leg is the biggest). None → skip the tx.
- `action`: wallet is the token's `toUserAccount` → `BUY`; `fromUserAccount` → `SELL`.
- `tokenAmount` = that transfer's amount (UI/decimal-adjusted, as Helius reports it).
- `amountSol`: sum `nativeTransfers` amounts (lamports→SOL, /1e9) where the wallet is the payer
  (BUY: `fromUserAccount === wallet`) or payee (SELL: `toUserAccount === wallet`). Fallback to a
  wSOL `tokenTransfer` amount if there are no native transfers (wrapped-SOL swaps).
- `signature`, `slot`, `blockTime` (= `timestamp` seconds → Date) from the top level.
- `eventTime = blockTime.toISOString()`, `processingTime` injected.

Numbers as strings into the numeric columns. `amountUsd` is NOT computed here (null at M1).

## Persistence

`wallet_transaction` after migration 0001: `{ id (uuid), wallet, action, mint, amount_sol,
token_amount, amount_usd (nullable), block_time, tx_hash unique, slot }`. Insert with
`onConflictDoNothing({ target: txHash }).returning()` → the returned rows are the new ones to
publish. `token` upserted (`onConflictDoNothing` on mint) with `first_seen_at`; a freshly
inserted token row triggers `token.activity.detected`.

`id` is a fresh uuid per row; `tx_hash` (= signature) is the idempotency key. A single Solana tx
can contain multiple swaps by the same wallet on different mints → multiple rows sharing a
signature would collide on the unique `tx_hash`. M1 keeps one row per (signature) — the largest
leg — matching the "one target token per swap" parse rule; multi-swap decomposition is a later
refinement if the data shows it matters.

## HeliusRestClient (rest.ts)

`https://api.helius.xyz/v0/addresses/{address}/transactions?api-key=…` returns the enhanced-tx
array — the same shape `parse.ts` handles, so history and webhook reuse one parser. Timeout via
AbortController; non-2xx → Retryable (5xx) / Fatal (4xx) like the Bybit client. Exposes
`getAddressTransactions(address, { before?, until?, limit? })`.

## Liveness (§10 caveat) — liveness.ts

Push-only webhooks can't be heartbeated directly, so "subscription died" is ambiguous with
"wallets quiet." Resolution (strategy (b), REST re-check, from §10):

- webhook receipt heartbeats `helius.wallet_webhook` (threshold 60s, already in thresholds.ts).
- `HeliusLivenessProbe` polls a configured **canary wallet** (known high-activity) via REST every
  N minutes; on a successful response it heartbeats a separate `helius.rest` feed.
- The signal that matters: **`helius.wallet_webhook` stale AND `helius.rest` fresh** ⇒ the webhook
  path is likely broken (Helius is reachable, txs exist, but nothing is arriving by webhook).
  M1 logs this at warn via the monitor's onStale plus a cross-check; wiring it to BLOCK dependent
  TradingAgents is a later milestone (no TradingAgents yet).
- Inert without `HELIUS_API_KEY` (probe not started) — the webhook-receipt heartbeat still works.

`helius.rest` threshold added to thresholds.ts (= 3 × probe interval, same rule as the poll feed).

## Worker wiring

`apps/worker/main.ts`: after Bybit, call `registerHeliusIngestion({ bus, db, monitor })` and, if
`HELIUS_API_KEY` set, construct + start a `HeliusLivenessProbe` (canary wallet a constant for
now). Shutdown stops the probe.

## Testing

Unit (pure/fixture, no network):
- parse: a SOL→token SWAP → one BUY row (mint, amounts, direction, signature, blockTime); a
  token→SOL SWAP → SELL; routing dust ignored (largest leg wins); non-SWAP → `[]`; non-array → `[]`.
- rest: envelope/HTTP error split (fake fetch); parses an address-history fixture via parse.ts.
- liveness: probe heartbeats `helius.rest` on success, not on failure (fake rest + monitor).

Integration:
- Postgres (skipIf no DATABASE_URL): the ingest consumer persists a parsed batch once; a
  re-delivered batch adds no rows and publishes nothing new (tx_hash idempotence). Uses a fake
  bus; drives the registered handler directly.
- Helius REST (opt-in `HELIUS_LIVE=1`, needs key): `getAddressTransactions` for a known active
  address returns parseable enhanced txs.
