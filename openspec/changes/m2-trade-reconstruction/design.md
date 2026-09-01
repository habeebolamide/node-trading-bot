# Design: m2-trade-reconstruction

Read Part II §2/§4 alongside.

## Reconstruction algorithm (reconstruct.ts — pure, the tested core)

Input: `wallet_transaction` rows for one (wallet, mint), ascending by `blockTime`. Output:
`WalletTrade[]`.

Average-cost, position-closing model (chosen over FIFO for MVP — simpler, robust for memecoin
accumulate/dump patterns; FIFO lot-tracking is a later refinement if per-lot analysis is ever
needed):

```
pos = 0 tokens; solIn = 0; solOut = 0; open trade = none
for each swap (ascending):
  BUY:
    if no open trade → open one (openedAt = swap.blockTime)
    pos += tokenAmount; solIn += amountSol; tokensBought += tokenAmount; buyCount++
  SELL:
    sell = min(tokenAmount, pos)            # clamp: can't sell more than tracked (airdrop/transfer-in)
    if tokenAmount > pos → flag TRANSFER_IN_SUSPECTED
    solOut += amountSol; tokensSold += sell; pos -= sell; sellCount++
    if pos <= EPS and open trade exists → CLOSE:
      realizedReturnPct = solIn > 0 ? (solOut - solIn)/solIn : null
      won = solOut > solIn
      holdingPeriodSec = closedAt - openedAt
      emit trade; reset accumulators
at end: any open trade stays status=OPEN (no realized outcome — still holding)
```

- **Realized return is SOL-denominated** (proceeds vs cost, both in SOL). USD conversion is not
  needed for ranking and isn't computed here (matches M1's amount_usd=null decision).
- **EPS** guards dust: a position under a tiny fraction of `tokensBought` counts as closed (wallets
  leave sub-1% dust). EPS is a config constant, documented.
- **Re-entry**: buy → full sell (close) → buy again = two separate trades on the same mint. The
  `(wallet, mint)` pair is NOT unique on `wallet_trade`; `openedAt` disambiguates.
- Pure function, no DB/clock — fixture-tested for: single round-trip, partial sells then close,
  re-entry (two trades), never-closed (OPEN), oversell clamp+flag, all-loss, zero-cost guard.

## Backfill (backfill.ts + scripts/backfill-wallet.ts)

Per §4 "backfill on add": fetch a wallet's full parsed history and reconstruct.

```
for each wallet:
  page through HeliusRestClient.getAddressTransactions(wallet, {before})   # M1 client, paged
    → parse (M1 parser) → upsert wallet_transaction (tx_hash idempotent)
  then reconstruct: for each mint the wallet touched, load its swaps ascending → reconstruct.ts
    → upsert wallet_trade
```

Helius history is paged newest-first via a `before` signature cursor; loop until a short/empty
page. Rate-limited (delay between calls) like the Bybit backfill. Idempotent: re-running re-upserts
the same `wallet_transaction` (tx_hash) and recomputes `wallet_trade` deterministically.

`wallet_trade` upsert strategy: reconstruction is deterministic from the full swap set, so a
re-run should replace a wallet+mint's trades rather than duplicate. Approach: delete-then-insert a
wallet's `wallet_trade` rows inside a transaction per (wallet, mint) recompute — trades aren't
immutable facts like predictions (rule 10 is about `Prediction`, not reconstructed views), so
recomputing them is fine and keeps them consistent with the latest `wallet_transaction` set.

## Schema (migration 0002)

`wallet_trade`:
```
id text PK (uuid)
wallet text NOT NULL
mint text NOT NULL
status text NOT NULL              -- OPEN | CLOSED
opened_at timestamptz NOT NULL
closed_at timestamptz             -- null while OPEN
buy_count int NOT NULL
sell_count int NOT NULL
total_sol_in numeric NOT NULL
total_sol_out numeric NOT NULL
tokens_bought numeric NOT NULL
tokens_sold numeric NOT NULL
realized_return_pct numeric       -- null while OPEN
won boolean                       -- null while OPEN
holding_period_sec bigint         -- null while OPEN
flags text[]                      -- e.g. {TRANSFER_IN_SUSPECTED}
index (wallet, mint), index (wallet, opened_at)
```

`trade_outcome` is intentionally NOT created here — it carries the multi-horizon forward returns
(§3), whose data source is the change-2 gating decision. Adding it now would bake in a shape
before that's settled.

## Testing

Unit (pure, no I/O): the reconstruction cases above — the correctness that everything downstream
inherits.
Integration (live Postgres, skipIf no DATABASE_URL): seed a handful of `wallet_transaction` rows
for a synthetic wallet (buy, partial sell, final sell, re-buy) → run the persist-side reconstruct
→ assert two `wallet_trade` rows with correct realized returns; re-run → still two (idempotent).
Opt-in (HELIUS_LIVE=1): backfill one real address end-to-end and assert trades reconstruct.
