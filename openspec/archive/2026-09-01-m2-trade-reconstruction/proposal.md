# Change: m2-trade-reconstruction

> **COMPLETED 2026-09-01.** Shipped `packages/wallets`: `reconstruct.ts` (pure, zero-import
> average-cost round-trip reconstruction with SOL-denominated realized P&L — open/close/re-entry/
> partial-sells/dust-close/oversell-clamp/zero-cost guard), `persist.ts` (deterministic recompute
> as delete-then-insert per wallet+mint), `backfill.ts` (pages Helius history → upsert
> `wallet_transaction` → reconstruct). Added `HeliusRestClient.getAddressTransactionsPage` so full
> history pages reliably by the RAW signature/count (the parser keeps only swaps, which alone can't
> drive pagination). Schema migration 0002 (`wallet_trade`) applied. `scripts/backfill-wallet` CLI
> (--addresses / --file).
>
> **Verified:** typecheck green; **80/83 tests pass** (3 opt-in live skipped). 9 reconstruction
> unit cases + a live-Postgres test (seeded swaps → two closed trades with correct ±0.5 realized
> returns; re-run idempotent). Live smoke: the whole backfill chain ran against real Helius with no
> error (paged→parsed→persisted→reconstructed). `trade_outcome` intentionally deferred to change 2
> (it carries the forward-horizon returns).
>
> **Deviations from spec:** none material. Average-cost (not FIFO) reconstruction; dust threshold
> 1%; a sell with no tracked position is skipped (untracked/airdropped tokens). Next: m2-wallet-scoring.

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping — awaiting review)
**Milestone:** M2 — Wallet Intelligence (§30), change 1 of 3
**Implements:** Part II §2 (transaction/trade reconstruction, historical performance), §13
(`WalletTrade`, `TradeOutcome`), §4 (backfill-on-add mechanism). §33 rules 8/12.

## M2 overview (the whole milestone, for context)

M2 turns raw wallet swaps (which the M1 Helius adapter already ingests into `wallet_transaction`)
into an **objective wallet ranking** — the smart-money foundation everything memecoin-side leans
on. Goal (§30): *objectively rank wallets.* Decomposed into three OpenSpec changes:

1. **m2-trade-reconstruction** ← this change. Reconstruct round-trip trades + realized P&L from
   raw swaps. Needs no external price data — a wallet's own buys/sells price themselves.
2. **m2-wallet-scoring** — the §4/Task-6 scoring formula (Beta-Binomial shrinkage, percentile
   normalization, n<10 unrated), the append-only `WalletScoreEvent` point-in-time log + "as of T"
   reader (rule 21), `BrainWalletMemory`, recompute triggers, a versioned wallet-scoring config,
   and the `wallet.score.updated` / `wallet.profile.updated` events. **Gated by the early-entry
   data decision (see review ask below).**
3. **m2-seed-analysis** — seed the ~100 wallets (manual roster, §11), run backfill→reconstruct→
   score across them, then the Part II §4 **seed-history analysis pass** that settles the four
   placeholder tunables (`batchingWindowMs`, `walletExitThreshold`, `profitLadder` rungs,
   freshness `τ`) from real data, writing the findings to `docs/research/`.

## Why (this change)

Everything downstream — win rate, profitability, holding time, early-entry edge — is computed
over *trades*, not raw transfers. A `wallet_transaction` is one swap; a **trade** is a round-trip
(accumulate → distribute) with a realized return. This change builds that reconstruction and the
per-wallet history backfill that feeds it.

## What changes

New package **`packages/wallets`** (M2's home; grows in change 2):

- **`reconstruct.ts`** — pure: an ordered swap stream for one (wallet, mint) → `WalletTrade[]`.
  Average-cost position tracking: BUYs accumulate tokens + SOL cost; SELLs realize proceeds; a
  trade CLOSES when the tracked position returns to ~0 (epsilon), then a fresh trade opens on the
  next buy. Positions still open at the end stay `OPEN` (no outcome yet). Sells exceeding tracked
  position (tokens received via transfer/airdrop, not a tracked buy) are clamped and flagged —
  never fabricated (rule 25 spirit).
- **`backfill.ts`** + a `scripts` runner — fetch a wallet's full history via the M1
  `HeliusRestClient.getAddressTransactions` (paged with `before`), persist to `wallet_transaction`
  (tx_hash idempotent), then reconstruct its trades. This is §4 "backfill on add": a newly-added
  wallet is populated from its real history, not left blank.

Schema (migration 0002): `wallet_trade` (id, wallet, mint, status OPEN|CLOSED, openedAt,
closedAt?, buyCount, sellCount, totalSolIn, totalSolOut, tokensBought, tokensSold,
realizedReturnPct?, won?, holdingPeriodSec?, flags) + `trade_outcome` *deferred to change 2* (it
carries the multi-horizon forward returns, which depend on the early-entry decision).

## What this change does NOT do

- No scoring, no `WalletScoreEvent`, no `BrainWalletMemory` (change 2).
- No forward-horizon returns / early-entry edge (change 2 — needs the price-series decision).
- No convergence / funder clustering (that's M3).
- No automated wallet discovery (M3; MVP is manual seed, §11).

## Review ask (the one structural decision — gates change 2, not this one)

**Early-Entry Edge is 25% of the wallet score (§4) and is defined as forward returns at 5m/15m/
30m/1h/6h/24h after entry (§3) — but that needs a per-token price *series*, which §25 deliberately
scopes out of MVP (no bulk Solana historical archival).** This is a real plan tension I must
resolve before change 2. Options are in the question accompanying this proposal. This change
(reconstruction + realized P&L) is unaffected and can proceed either way.
