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
- [~] TEST: fast-lane job dequeues before older normal job — WRITTEN, skips w/o REDIS_URL
      (unverified against live Redis — see Blockers)

## 3. packages/database
- [x] Drizzle client (pooled `DATABASE_URL`) + createDb/closeDb; getDb lazy singleton
- [x] schema: `domain_event`, `processed_event`, `market_candle`, `funding_rate`,
      `open_interest`, `wallet_transaction` (tx_hash unique), `token`
- [x] composite PK + index on `market_candle (symbol, timeframe, open_time)`
- [x] `drizzle.config.ts`; generated migration 0000_deep_toro.sql (7 tables, verified SQL)
- [x] `withIdempotency` — INSERT processed_event + handler in one txn (§29)
- [~] TEST: concurrent double-insert on `processed_event` → exactly one effect — WRITTEN,
      skips w/o DATABASE_URL (unverified against live Postgres — see Blockers)
- [~] TEST: duplicate `market_candle` rejected by unique constraint — WRITTEN, skips w/o DB

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
- [x] `npm test` green for unit suite (16 passed, 3 integration skipped)
- [~] integration suite verified against live Redis + Postgres — BLOCKED (see below)
- [ ] `npm run db:migrate` applied to a dev DB (needs DIRECT_URL reachable)
- [ ] PR description: plan sections implemented, ambiguities resolved (schema home in
      packages/database; conditional provider-key config; HELIUS_WEBHOOK_RECEIVED added)
- [ ] ARCHIVE this change → `openspec/archive/<date>-m1-foundation-core/` — only after the
      integration suite passes (the §29 concurrency test is acceptance-critical)

## Blockers (env, flagged to user)
- `REDIS_URL` not in `.env` — provision Upstash (or local Redis) to run the fast-lane +
  worker integration tests.
- No dev Postgres confirmed reachable for tests — the concurrency/constraint tests and
  `db:migrate` need one (the real DATABASE_URL is production; use a dev/branch DB for tests).
