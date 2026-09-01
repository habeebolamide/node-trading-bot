# Tasks: m1-foundation-core

Session continuity lives here. Check items off as completed. `[ ]` todo, `[x]` done,
`[~]` in progress.

## 0. Workspace scaffolding
- [ ] `packages/domain` package.json (`@tip/domain`) + tsconfig extending base + src/index.ts
- [ ] `packages/events` package.json (`@tip/events`, dep on domain) + tsconfig + src/index.ts
- [ ] `packages/database` package.json (`@tip/database`, dep on domain) + tsconfig + src/index.ts
- [ ] `apps/api` package.json (private) + tsconfig + src/main.ts
- [ ] `apps/worker` package.json (private) + tsconfig + src/main.ts
- [ ] Add all five as references in root `tsconfig.json`
- [ ] `npm install` resolves the workspace graph; `npm run typecheck` green on empty stubs

## 1. packages/domain
- [ ] `config.ts` — Zod schema over `.env.example` vars; single `process.env` read; throws
      FatalError listing all problems; exports frozen typed `config`
- [ ] `DomainEvent<T>` envelope type (both clocks: eventTime + processingTime)
- [ ] error hierarchy: `RetryableError`, `FatalError`, `ValidationError`
- [ ] shared enums/brands (Domain = 'perp' | 'memecoin', Timeframe, Symbol brand)
- [ ] TEST: config fails loudly on missing required var; passes on valid env

## 2. packages/events
- [ ] `EVENT_NAMES` frozen constant covering the full §10 list
- [ ] event bus over BullMQ: `publish(event)`, `subscribe(queue, handler)`
- [ ] `withIdempotency(event, fn)` — INSERT processed_event + handler in one txn (§29)
- [ ] queue registry: the §11 queues; `FAST` / `NORMAL` priority constants
- [ ] TEST: envelope round-trips (both clocks preserved)
- [ ] TEST: fast-lane job dequeues before older normal job

## 3. packages/database
- [ ] Drizzle client (pooled `DATABASE_URL`) + migration client (`DIRECT_URL`)
- [ ] schema: `domain_event`, `processed_event`, `market_candle`, `funding_rate`,
      `open_interest`, `wallet_transaction` (tx_hash unique), `token`
- [ ] composite unique + index on `market_candle (symbol, timeframe, open_time)`
- [ ] `drizzle.config.ts`; generate initial migration into `packages/database/migrations`
- [ ] TEST: concurrent double-insert on `processed_event` → exactly one effect (real Postgres)
- [ ] TEST: duplicate `market_candle` rejected by unique constraint

## 4. apps/api
- [ ] Express app + HTTP server + WS server object (attach point for later)
- [ ] `GET /health` — db + redis pings, uptime
- [ ] `POST /webhooks/helius` — constant-time secret check, 401 on bad, enqueue raw body,
      fast 200
- [ ] every I/O has a timeout; graceful shutdown
- [ ] TEST: /health returns ok with deps up; webhook rejects bad secret

## 5. apps/worker
- [ ] BullMQ Worker bootstrap from processor registry (empty registry object exported for
      later milestones to push into)
- [ ] both priority lanes wired; graceful shutdown (SIGTERM drain)
- [ ] TEST: enqueue no-op job → worker runs it

## 6. Wrap-up (part of "done")
- [ ] `npm run typecheck` + `npm test` green
- [ ] README/docs note any deviations
- [ ] PR description: plan sections implemented, ambiguities resolved (schema home; conditional
      provider-key config)
- [ ] ARCHIVE this change folder → `openspec/archive/<date>-m1-foundation-core/` with a
      completion summary appended to proposal.md
