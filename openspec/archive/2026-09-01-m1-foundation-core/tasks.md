# Tasks: m1-foundation-core

Session continuity lives here. Check items off as completed. `[ ]` todo, `[x]` done,
`[~]` in progress / blocked.

## 0. Workspace scaffolding
- [x] `packages/domain` package.json (`@tip/domain`) + tsconfig extending base + src/index.ts
- [x] `packages/events` package.json (`@tip/events`, dep on domain) + tsconfig + src/index.ts
- [x] `packages/database` package.json (`@tip/database`, dep on domain) + tsconfig + src/index.ts
- [x] `apps/api` package.json (private) + tsconfig + src/main.ts
- [x] `apps/worker` package.json (private) + tsconfig + src/main.ts
- [x] Add all five as references in root `tsconfig.json`
- [x] `npm install` resolves the workspace graph; `npm run typecheck` green

## 1. packages/domain
- [x] `config.ts` — Zod schema over `.env.example` vars; single `process.env` read; throws
      FatalError listing all problems; exports frozen typed `config` (loadConfig/getConfig)
- [x] `DomainEvent<T>` envelope type (both clocks: eventTime + processingTime)
- [x] error hierarchy: `RetryableError`, `FatalError`, `ValidationError` (+ isRetryable)
- [x] shared enums/brands (Domain, Timeframe, TradingStyle, MarketSymbol/Mint/WalletAddress)
- [x] TEST: config fails loudly on missing required var; passes on valid env (5 tests)
- [x] TEST: error hierarchy instanceof + frozen context (4 tests)

## 2. packages/events
- [x] `EVENT_NAMES` frozen constant covering the full §10 list (+ §40/§36 refs, raw hand-off)
- [x] event bus over BullMQ: `publish(queue, event)`, `createWorker(queue, handler)`;
      RetryableError→retry, else UnrecoverableError (fail fast)
- [x] queue registry: the §11 queues; `FAST` / `NORMAL` priority constants
- [x] TEST: fast-lane job dequeues before older normal job — VERIFIED against live Redis 8.10.1

## 3. packages/database
- [x] Drizzle client (pooled `DATABASE_URL`) + createDb/closeDb; getDb lazy singleton
- [x] schema: `domain_event`, `processed_event`, `market_candle`, `funding_rate`,
      `open_interest`, `wallet_transaction` (tx_hash unique), `token`
- [x] composite PK + index on `market_candle (symbol, timeframe, open_time)`
- [x] `drizzle.config.ts`; generated migration 0000_deep_toro.sql (7 tables, verified SQL)
- [x] `withIdempotency` — INSERT processed_event + handler in one txn (§29)
- [x] TEST: concurrent double-insert on `processed_event` → exactly one effect — VERIFIED
      against live Postgres 16 (10 racing workers, handler ran exactly once)
- [x] TEST: duplicate `market_candle` rejected by unique constraint — VERIFIED

## 4. apps/api
- [x] Express app (createApp with injected deps) + main.ts wiring + graceful shutdown
- [x] `GET /health` — db + redis pings (timeout-guarded), uptime, 503 on degraded
- [x] `POST /webhooks/helius` — constant-time secret check, 401 bad / 503 unconfigured,
      enqueue raw body under HELIUS_WEBHOOK_RECEIVED, fast 200
- [x] TEST: /health ok + degraded; webhook 401/200/503 paths (5 tests, fakes injected)

## 5. apps/worker
- [x] processor registry (register/registeredProcessors, double-wire guard) — empty for now
- [x] runner: `startWorkers` + `wrapProcessor` (idempotency-wrapped); main.ts + SIGTERM drain
- [x] TEST: registry + startWorkers wiring (2 tests, fake bus)

## 6. Wrap-up (part of "done")
- [x] `npm run typecheck` green
- [x] `npm test` green — full suite 19/19 (incl. all 3 integration tests, live infra)
- [x] integration suite verified against live Redis 8.10.1 + Postgres 16 (local)
- [x] `npm run db:migrate` applied migration 0000 to local `trading_db`
- [x] Ambiguities resolved: schema home in packages/database (not db/); conditional
      provider-key config; HELIUS_WEBHOOK_RECEIVED added as raw ingestion hand-off marker
- [x] ARCHIVE this change → `openspec/archive/2026-09-01-m1-foundation-core/`

## Local dev infra (resolved this session)
- Redis: Homebrew `redis` 8.10.1 (needed a from-source `openssl@3` first on this Intel /
  Tier-3 Mac), running daemonized on `redis://localhost:6379`.
- Postgres: local server on `localhost:5432` db `trading_db` (user-provided). `.env` wired:
  active DATABASE_URL/DIRECT_URL point there (`?schema=public` dropped — postgres.js rejects
  it), old Supabase/prisma URLs left commented, REDIS_URL added. Docker deliberately not used.
