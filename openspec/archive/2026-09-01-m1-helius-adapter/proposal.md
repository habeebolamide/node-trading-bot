# Change: m1-helius-adapter

> **COMPLETED 2026-09-01.** Grew `packages/ingestion` with the Solana/Helius half behind the
> rule-17 seam: `NormalizedWalletTx` + `SolanaDataProvider` (provider.ts), `helius/parse.ts`
> (pure enhanced-tx → normalized swaps: SWAP-only, wSOL-aware largest-leg, BUY/SELL, SOL+token
> amounts), `helius/rest.ts` (`HeliusRestClient.getAddressTransactions`, reused by the parser),
> `helius/ingest.ts` (`createHeliusHandler`/`registerHeliusIngestion` — parse → persist new-only
> in the idempotency txn → publish `wallet.transaction.detected`/`token.activity.detected`
> post-commit → webhook heartbeat), and `helius/liveness.ts` (`HeliusLivenessProbe`, the §10
> caveat resolution via REST re-check + the webhook-stale/rest-fresh cross-check). Schema
> migration 0001 enriched `wallet_transaction` (`amount_sol`, `token_amount`; `amount_usd`
> nullable) and was applied. Worker registers Helius ingestion always and starts the probe when
> `HELIUS_API_KEY` is set.
>
> **Verified:** typecheck green; **62/65 tests pass** (3 opt-in live skipped by default).
> Covered: the parser across BUY/SELL/dust/wSOL-fallback/non-swap/non-array, REST error split +
> history parse, liveness heartbeat-on-success-only, and live-Postgres ingest idempotence by
> BOTH event-id and tx_hash (re-delivery adds no rows, emits nothing new, amount_usd null).
> Live-network verified with the real key: `getAddressTransactions` against Helius returns and
> parses enhanced transactions.
>
> **Deviations from spec:** none material. As designed: no buy/convergence/exit events, no USD
> valuation, no scoring backfill, no webhook auto-registration (operational). One row per
> signature (largest leg) — multi-swap decomposition deferred.
>
> **Follow-ups:** operator must create the Helius webhook subscription pointing at the api
> `/webhooks/helius` endpoint for live wallet data to flow. Next: `m1-replay-engine` (change 4).

**Status:** COMPLETED — archived
**Original status:** PROPOSED (building straight through)
**Milestone:** M1 — Data Foundation (§30), change 3 of 4
**Implements:** Part II §7 (Helius provider — free tier, webhooks + enhanced parsed tx), §2/§4
(wallet activity + per-address history for later scoring backfill), §12 (normalization), §17
(provider adapter rule), §10 (webhook staleness caveat — canary / REST re-check), §29
(tx_hash idempotency). §33 rules 8/12/17/19.

## Why

The memecoin side's raw feed is Helius. `apps/api` already receives + authenticates the webhook
and enqueues the raw body (`helius.webhook.received`, change 1). This change builds the
consumer: parse Helius **enhanced** swap transactions → normalized wallet transactions (§12) →
persist (`wallet_transaction`, `token`) → emit `wallet.transaction.detected` /
`token.activity.detected`. It also resolves the §10 Helius liveness caveat, which the plan says
"must be settled before shipping the Helius adapter (M1)."

## What changes

`packages/ingestion` grows a `solana/` (helius) half, mirroring `bybit/`:

- **`solana/provider` types** — `NormalizedWalletTx` + a `SolanaDataProvider` interface
  (per-address history for the M2 wallet backfill, §4).
- **`helius/parse.ts`** — pure: a Helius enhanced-tx array → `NormalizedWalletTx[]`. Determines
  wallet (feePayer), target mint (the non-wSOL/stable leg), BUY/SELL direction, token + SOL
  amounts, signature, blockTime, slot. Heavily fixture-tested.
- **`helius/rest.ts`** — `HeliusRestClient.getAddressTransactions(address)` (enhanced parsed
  history, timeout-guarded, api-key) — the per-address lookup §4's wallet backfill will use, and
  the liveness probe below.
- **`helius/ingest.ts`** — `registerHeliusIngestion({bus, db, monitor})`: a worker on
  `blockchain-ingestion` that parses each `helius.webhook.received`, persists **only newly-seen**
  transactions (tx_hash unique, §29) inside the idempotency transaction, then publishes events
  for the new ones and heartbeats the webhook feed.
- **`helius/liveness.ts`** — `HeliusLivenessProbe`: the §10 caveat resolution. Periodically REST
  re-checks a canary/known-active wallet; heartbeats a distinct `helius.rest` feed on success. If
  the webhook feed is stale while `helius.rest` is fresh, that's the actionable "webhook path is
  broken (not just quiet)" signal — logged.

Schema: **migration 0001** enriches `wallet_transaction` for the swap shape — adds `amount_sol`
and `token_amount` (numeric), and makes `amount_usd` **nullable** (USD valuation is an M2
enrichment via a SOL-price join; M1 captures the deterministic on-chain amounts).

Worker wiring: register Helius ingestion into the existing worker; start the liveness probe when
`HELIUS_API_KEY` is set.

## What this change does NOT do

- **No `memecoin.wallet.buy.detected` / convergence / exit events** — those imply a watched-wallet
  universe + funder clustering (M2/M3). M1 emits the low-level `wallet.transaction.detected`.
- **No wallet scoring / backfill run** — `getAddressTransactions` is provided for M2 to drive;
  the scoring pipeline is M2.
- **No USD valuation** — `amount_usd` stays null in M1 (nullable), enriched in M2.
- **No webhook auto-registration with Helius** — creating the Helius webhook subscription
  (pointing it at the api endpoint) is an operational step; the adapter consumes what arrives.
- No pool/reserve/depth ingestion (that's the paper-engine fill model, later).

## Resolved solo (flag)

- Only `type: "SWAP"` transactions are parsed in M1; other enhanced types return nothing (no
  error). SOL-paired swaps are the memecoin norm; USDC/token-token pairs are a later addition.
- Target token = the wallet-involved token transfer whose mint isn't wrapped-SOL, largest by
  amount (defeats routing dust). Direction from whether the wallet received or sent it.
- Migration 0001 alters an archived-change table — legitimate under "schema grows per milestone."
