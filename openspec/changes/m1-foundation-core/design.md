# Design: m1-foundation-core

References the plan by section; does not restate it. Read §10, §11, §29 alongside this.

## Package graph (dependency direction →)

```
domain  ←  events  ←  database
   ↑          ↑           ↑
   └──────────┴───────────┴──── apps/api, apps/worker
```

`domain` depends on nothing internal. `events` depends on `domain` (envelope + error types).
`database` depends on `domain` (config, brands). Apps depend on all three. No cycles. Workspace
deps use `"@tip/domain": "*"` and TS project references mirror the same edges.

## packages/domain

### config.ts — the single env boundary (CLAUDE.md convention)

One Zod schema validates the entire environment at process start; it throws a `FatalError`
listing every missing/invalid var at once (not one-at-a-time). Exports a frozen typed `config`
object. **No other file reads `process.env`.** A test asserts that a missing required var fails
loudly. Fields mirror `.env.example`. `DATABASE_URL`/`DIRECT_URL`/`REDIS_URL` required always;
provider keys required conditionally (e.g. `HELIUS_API_KEY` required only when the Helius
adapter is enabled — modeled as an optional-with-runtime-guard, so `m1-foundation-core` boots
without them).

### DomainEvent envelope (§10)

```ts
interface DomainEvent<T = unknown> {
  id: string;            // uuid v4, the idempotency key (§29)
  type: string;          // one of the EVENT_NAMES constants (packages/events)
  version: number;       // payload schema version (Task 3 — starts at 1)
  eventTime: string;     // ISO — when it actually happened (§10 event-time)
  processingTime: string;// ISO — when we received it (§10 processing-time)
  source: string;        // adapter/producer id
  correlationId?: string;
  payload: T;
}
```

Event-time vs processing-time are **both first-class from day one** (§10) — the point-in-time
correctness the whole system leans on (rules 21/22) depends on this separation existing before
any data flows. Watermark tolerance is a Task-2 detail deferred to the adapters, but the two
clocks are carried here.

### Errors

`RetryableError` (transient I/O — bus retries), `FatalError` (data corruption / config —
alert, do not retry), `ValidationError` (bad input — reject). Never throw strings; never
swallow (CLAUDE.md). BullMQ retry policy keys off `RetryableError` vs the rest.

## packages/events

### Event names (§10)

A frozen `EVENT_NAMES` object with every event from the §10 list, lowercase-dotted, matched
exactly (rule: names match the plan). Only the M1-relevant producers emit in this milestone,
but the full constant set is declared so later milestones reference, never re-declare.

### Event bus over BullMQ

Thin abstraction: `publish(event: DomainEvent)` enqueues onto the queue mapped from
`event.type`; `subscribe(queue, handler)` registers a processor. The bus is the *only* place
that touches BullMQ job APIs, so swapping transports later is contained. `event.id` is the
BullMQ `jobId` → BullMQ's own dedup gives a first layer, `processed_event` gives the durable
second layer (below).

### Idempotency helper (§29, rule 12)

```
withIdempotency(event, async () => { ...handler... })
```

Attempts `INSERT INTO processed_event (event_id)`; on unique-violation the event was already
handled → skip. The insert and the handler's writes run in **one transaction**, so a crash
mid-handler rolls back the claim too (at-least-once, exactly-once effect). This is the
structural enforcement of §29 — never a check-then-write.

## packages/database

### Schema — data-foundation slice only

Tables in this change (Drizzle, snake_case columns):

- **`domain_event`** (§13) — durable event log; `id` PK, indexed on `(type, event_time)`.
- **`processed_event`** (§29) — `event_id` PK. The idempotency ledger.
- **`market_candle`** — `(symbol, timeframe, open_time)` composite unique; OHLCV + `close_time`.
  Composite index `(symbol, timeframe, open_time)` for chronological range scans (§25). This is
  the "historical store and live store are one table" from §25 — live WS closed candles and the
  Bybit backfill both write here.
- **`funding_rate`** — `(symbol, funding_time)` unique; rate value.
- **`open_interest`** — `(symbol, snapshot_time)` unique; oi value.
- **`wallet_transaction`** (§13) — raw normalized on-chain action; `tx_hash` **unique** (§29
  example), indexed by `(wallet, block_time)`.
- **`token`** (§13) — token profile row keyed by mint; upserted on sight.

Deferred to later milestones (NOT in this change): `TradingAgent`, `Wallet` (scoring),
`WalletScoreEvent`, `WalletTrade`, `TradeOutcome`, `Signal`, `Convergence`, `Prediction`,
`PredictionOutcome`, all `Brain*`, `Agent*`, `Paper*`, `TradeAutopsy`, `LearningHypothesis`,
`LLMCallLog`, `ScoringConfig`. Each arrives with its consuming milestone.

### Migrations

`drizzle-kit` generates SQL into `packages/database/migrations/`; `DIRECT_URL` used for
migration (non-pooled), `DATABASE_URL` (pooled) at runtime. Migrations are checked in and
reversible (CLAUDE.md "done").

## Redis + BullMQ (§11)

One shared `ioredis` connection (BullMQ-compatible options). Queue registry declares the §11
queues: `blockchain-ingestion`, `market-ingestion`, `wallet-analysis`, `token-analysis`,
`signal-processing`, `agent-analysis`, `brain-processing`, `prediction-evaluation`,
`paper-portfolio`, `analytics`. **Fast-lane priority** (§11): the reaction path
(`detection → paper fill → telegram`) uses BullMQ job `priority` ahead of the heavy tier —
encoded as two priority constants (`FAST`, `NORMAL`); a test asserts a FAST job dequeues ahead
of an earlier-enqueued NORMAL job. Actual fill/telegram logic is later — this change only
proves the lane ordering works.

## apps/api

Express + a WS server stub (WS surfaces are §26 dashboard, but the server object is created
here so adapters can attach). Endpoints:

- `GET /health` — returns `{ status, db: ok|fail, redis: ok|fail, uptime }`; pings both.
- `POST /webhooks/helius` — verifies `HELIUS_WEBHOOK_SECRET` (constant-time compare), returns
  `200` fast, enqueues the raw body to `blockchain-ingestion` for the (future) Helius adapter to
  parse. Rejects unauthenticated calls with `401`. No parsing here.

Every I/O call has a timeout (CLAUDE.md). Graceful shutdown drains the WS server + Redis.

## apps/worker

Bootstraps BullMQ `Worker`s from the processor registry (empty in this change — a registry
object other milestones push into), wires the two priority lanes, and handles graceful
shutdown (SIGTERM → stop accepting, finish in-flight, close). A smoke test enqueues a no-op job
and asserts the worker runs it.

## Testing (the invariants that would be catastrophic if wrong)

1. **config** — missing required var → startup throws with all problems listed; valid env →
   frozen typed object.
2. **envelope** — round-trips through publish/subscribe with both clocks preserved.
3. **idempotency** — a *real* concurrent double-insert on `processed_event` (two txns racing) →
   exactly one handler effect (§29 demands a real concurrent test, not a mock).
4. **fast-lane** — FAST job dequeues before an older NORMAL job.
5. **market_candle** — the `(symbol, timeframe, open_time)` unique constraint rejects a
   duplicate candle (backfill re-run idempotence, §25 reproducibility).

Redis/Postgres for tests: a local instance or the hosted dev DB via `.env`; the concurrency
test needs a real Postgres (constraint behavior), not an in-memory fake.

## Open question resolved solo (flag in PR)

The plan shows both `db/schema.ts` (§28) and `packages/database` (CLAUDE.md layout). Resolved:
schema + client live in **`packages/database/src`**, migrations in
`packages/database/migrations`. The top-level `db/` is not created — one home for schema avoids
the two-locations drift the plan itself warns about elsewhere. Noted here per CLAUDE.md
"ambiguity resolved on your own."
