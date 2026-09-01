# Change: m1-foundation-core

> **COMPLETED 2026-09-01.** Shipped the data-layer spine: `@tip/domain` (config.ts single Zod
> env boundary, DomainEvent envelope with event-time + processing-time, typed error
> hierarchy), `@tip/events` (EVENT_NAMES for the §10 list, EventBus over BullMQ with
> RetryableError-driven retry, §11 queue registry + FAST/NORMAL lanes), `@tip/database`
> (Drizzle client + 7-table data-foundation slice, withIdempotency one-txn claim, migration
> 0000), `apps/api` (/health + authenticated Helius webhook receiver, raw hand-off), and
> `apps/worker` (idempotency-wrapped processor registry + runner). Typecheck green; **19/19
> tests pass**, including the acceptance-critical §29 real-concurrency test (10 racing workers
> → exactly one effect), the candle composite-unique rejection, and the §11 fast-lane ordering
> — all verified against live Postgres 16 + Redis 8.10.1. Migration 0000 applied to local
> `trading_db`.
>
> **Deviations from spec:** none material. Build-time resolutions (all flagged in design.md):
> schema home is `packages/database` (not top-level `db/`); provider keys (Helius/DeepSeek/
> Telegram) are optional at the config layer so the foundation boots without them; a new event
> name `HELIUS_WEBHOOK_RECEIVED` was added as the raw-ingestion hand-off marker (per CLAUDE.md,
> new events get added to the §10 list). Local dev infra runs natively (Homebrew Redis + a
> local Postgres), not Docker.
>
> **Follow-ups:** the app processes don't yet load `.env` into `process.env` at boot (only
> drizzle-kit does) — wire a loader in each app's main.ts when the first adapter needs to run
> live. Next: `m1-bybit-adapter`.

**Status:** COMPLETED — archived
**Original status:** PROPOSED (awaiting review)
**Milestone:** M1 — Data Foundation (§30)
**Implements:** §10 (event architecture, envelope, staleness), §11 (queues + fast-lane
priority), §12 (normalization boundary), §13 (core entities), §28 (repo layout, ESM/npm
workspaces), §29 (concurrency/idempotency), §33 rules 8/12/17/19. Development conventions from
`CLAUDE.md` (config.ts + Zod, typed errors, ESM).

## Why

M1 turns "raw external data → clean internal events." Before any provider adapter (Bybit,
Helius) can be built, the platform needs the spine they plug into: validated config, the event
envelope + bus, the queue topology with the fast-lane priority split, the database client with
the idempotency constraints that make at-least-once delivery safe, and the two host apps
(`api`, `worker`) that run it all. This change builds exactly that spine and nothing above it —
no agents, no scoring, no dashboard (those are later milestones; building them now is drift,
per `CLAUDE.md` "Current milestone").

This is the first of four M1 changes. It is deliberately the "everything downstream imports
this" layer, so it is scoped tightly and tested hard.

## What changes

New workspaces (created here, grown later):

- **`packages/domain`** — `config.ts` (Zod-validated env, the *only* place `process.env` is
  read), the `DomainEvent<T>` envelope type, shared domain enums/brands, and the typed error
  hierarchy (`RetryableError` / `FatalError` / `ValidationError`).
- **`packages/events`** — the canonical event-name constants (the §10 list), the event-bus
  abstraction over BullMQ (`publish` / `subscribe`), and the idempotency helper that pairs the
  `processed_event` table with every consumer (§29).
- **`packages/database`** — the Drizzle client + the *data-foundation slice* of the schema
  (see design.md — NOT the full §13 entity list; only what M1 ingestion/replay needs), plus
  drizzle-kit migration wiring.

New apps:

- **`apps/api`** — Express skeleton: `GET /health` (liveness + DB/Redis checks, per the
  `added health check` intent carried over from the old bot) and the signature-verified Helius
  webhook *receiver* endpoint (payload parsing lands in `m1-helius-adapter`).
- **`apps/worker`** — BullMQ worker bootstrap with an (initially empty) processor registry and
  the two priority lanes wired (§11).

Shared infra: Redis/BullMQ connection module, the §11 queue registry, graceful shutdown.

## What this change does NOT do

- No provider adapters (Bybit/Helius) — separate changes.
- No replay engine or backfill — separate change.
- No agents, signals, brain, predictions, paper engine, LLM — later milestones.
- No dashboard.
- The Drizzle schema here is intentionally partial — only the tables M1 data ingestion and
  replay touch. Agent/Signal/Prediction/Brain/Paper tables are added by the milestones that
  own them, so the schema grows with real consumers rather than as one giant upfront guess.

## The M1 change sequence (this is #1 of 4)

1. **m1-foundation-core** ← this change
2. **m1-bybit-adapter** — Bybit WS+REST behind an adapter; normalize → events; write closed
   candles/funding/OI into the historical tables (§Part III §5, §12, §10 staleness).
3. **m1-helius-adapter** — Helius webhooks behind an adapter; parsed swaps → normalized
   wallet/token events; canary/liveness for the push-only feed (§Part II §7, §10 caveat).
4. **m1-replay-engine** — core chronological replay over local Postgres + the Bybit historical
   backfill script (§25). Prerequisite for pre-launch Brain Seeding.

## Review asks

1. Is the partial-schema approach (grow per milestone) acceptable, or do you want the full §13
   schema laid down now? (Recommendation: partial — matches `CLAUDE.md` "grow an existing one.")
2. Package scope `@tip/*` (Trading Intelligence Platform) — acceptable, or prefer another?
3. ESM (`"type": "module"`, NodeNext) is chosen for the whole repo — confirm no objection.
