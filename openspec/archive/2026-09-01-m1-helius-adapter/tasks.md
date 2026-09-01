# Tasks: m1-helius-adapter

`[x]` done · `[~]` blocked

## 1. Schema
- [x] migration 0001: `wallet_transaction` add `amount_sol`, `token_amount`; `amount_usd` nullable
- [x] schema.ts updated; regenerated (0001_puzzling_wraith.sql); applied to local DB

## 2. solana/helius
- [x] provider — `NormalizedWalletTx` + `SolanaDataProvider` (added to provider.ts)
- [x] `helius/parse.ts` — pure enhanced-tx → NormalizedWalletTx[] (SWAP only, wSOL-aware,
      largest-leg, BUY/SELL, SOL/token amounts, signature/slot/blockTime, native + wSOL fallback)
- [x] `helius/rest.ts` — `HeliusRestClient.getAddressTransactions` (api-key, timeout, 5xx/4xx split)
- [x] `helius/ingest.ts` — `createHeliusHandler` + `registerHeliusIngestion`: parse → persist new
      (tx_hash) in idempotency txn → publish wallet.transaction.detected / token.activity.detected
      (post-commit, new-only) → heartbeat webhook feed
- [x] `helius/liveness.ts` — `HeliusLivenessProbe` (canary REST poll → heartbeat helius.rest)

## 3. staleness
- [x] `helius.wallet_webhook` (existing) + `helius.rest` feed id + threshold (3×interval) consts

## 4. Worker wiring
- [x] register Helius ingestion always; start liveness probe when HELIUS_API_KEY set; shutdown
      stops probe; onStale cross-check logs "webhook path broken" when webhook stale + rest fresh

## 5. Tests
- [x] unit: parse — BUY/SELL/dust/wSOL-fallback/non-swap/no-leg/non-array (8)
- [x] unit: rest envelope + 5xx/4xx split + history parse (4)
- [x] unit: liveness heartbeats helius.rest on success only (2)
- [x] integration (live Postgres): ingest persists once; re-delivery (diff event id, same sig)
      adds nothing new; amount_usd null (1)
- [x] integration (opt-in HELIUS_LIVE=1): getAddressTransactions vs real Helius — VERIFIED

## 6. Wrap-up
- [x] typecheck + test green (62 pass, 3 opt-in skipped by default; Helius-live verified w/ key)
- [x] ARCHIVE → `openspec/archive/2026-09-01-m1-helius-adapter/` + summary
