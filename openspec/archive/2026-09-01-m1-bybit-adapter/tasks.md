# Tasks: m1-bybit-adapter

`[ ]` todo · `[x]` done · `[~]` in progress/blocked

## 0. Package scaffolding
- [x] `packages/ingestion` package.json (`@tip/ingestion`, deps domain/events/database + ws)
- [x] tsconfig (refs domain, events, database); added to root tsconfig references
- [x] added ref to `apps/worker` tsconfig + `@tip/ingestion` dep; vitest alias; typecheck green

## 1. Provider seam
- [x] `provider.ts` — `MarketDataProvider` + Normalized types (Kline/Ticker/Liquidation/
      AccountRatio), both clocks on each

## 2. bybit/
- [x] `topics.ts` — Timeframe↔interval map (both ways) + timeframeMs + topic builders/parsers
- [x] `normalize.ts` — pure raw→normalized (kline w/ confirm, ticker delta-merge, liquidation,
      rest kline, account-ratio); numbers as strings
- [x] `rest.ts` — `BybitRestClient` (klines/funding/OI/account-ratio), AbortController timeouts,
      retCode!==0 → Retryable/Fatal split
- [x] `ws.ts` — `BybitWsClient` (connect, batched subscribe, 20s ping, reconnect+resubscribe,
      open-gated subscribe, onMessage/onStateChange); fake-socket injectable
- [x] `adapter.ts` — `BybitAdapter.ingest()`: normalize → persist confirmed candles/funding
      (on-change) /OI (per-minute bucket) + publish 4 events; per-symbol ticker snapshot merge
- [x] `poller.ts` — `AccountRatioPoller` → emit perp.positioning.polled + heartbeat on success only

## 3. staleness/
- [x] `thresholds.ts` — §10 table (ms), kline 2×interval+30s + 3×poll as functions
- [x] `monitor.ts` — `FeedMonitor` (injected clock, heartbeat, check, one-shot stale/recover,
      isStale/snapshot)

## 4. Worker wiring
- [x] `apps/worker/main.ts` starts BybitAdapter × DEFAULT_PERP_SYMBOLS/TIMEFRAMES + poller +
      FeedMonitor check interval; graceful shutdown extended
- [x] `loadEnv()` added to @tip/domain and called in api + worker main (closes change-1 follow-up)

## 5. Tests
- [x] unit: kline confirm-gate, ticker delta-merge (funding+OI preserved), liquidation, rest
      kline, account-ratio (7)
- [x] unit: topic/interval round-trip (6)
- [x] unit: REST envelope retCode→Fatal, rate-limit→Retryable, 5xx/4xx split (4)
- [x] unit: FeedMonitor clock-driven stale/recover + kline/poll threshold values (6+2)
- [x] unit: adapter confirm-gate + funding-on-change + OI-per-minute bounding (4)
- [x] integration (live Postgres): candle re-delivery persists exactly once (1)
- [x] integration (opt-in BYBIT_LIVE=1): REST getKlines + account-ratio parse — VERIFIED (2)

## 6. Wrap-up
- [x] `npm run typecheck` + `npm test` green (47 pass, 2 opt-in skipped by default)
- [x] live WS smoke: connected to Bybit mainnet, received snapshot + delta ticker for BTCUSDT
      (throwaway scratchpad script; delta-merge path exercised). No automated live-WS test.
- [x] ARCHIVE → `openspec/archive/2026-09-01-m1-bybit-adapter/` + completion summary
