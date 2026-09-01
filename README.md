# Trading Intelligence Platform

A configurable, event-driven, **paper-trading** research system for two domains:

- **Memecoin** (Solana, via Helius)
- **Perpetuals** (Bybit)

It observes market/on-chain activity, ranks participants and patterns, lets specialized
deterministic agents analyze opportunities, combines evidence through a persistent **Brain**,
creates timestamped **predictions**, evaluates outcomes, and measurably improves the
intelligence layer from historical evidence. The LLM (DeepSeek, perp-only in MVP) synthesizes
and judges — it never computes scores and never invents market data.

> **No real-money execution.** Research / paper-trading only (Rule 20).

## Source of truth

- [`trading-intelligence-master-plan.md`](trading-intelligence-master-plan.md) — the
  architecture and every resolved decision. **The plan wins over instinct.**
- [`CLAUDE.md`](CLAUDE.md) — how to work in this repo (stack, conventions, the OpenSpec
  workflow, the §33 discipline rules).
- [`openspec/`](openspec/) — the spec-driven change workflow. Every subsystem starts as a
  change proposal here before code.

## Stack (locked — see CLAUDE.md)

TypeScript (strict) · Node LTS · Express · Drizzle · PostgreSQL · Redis + BullMQ ·
React + Vite + Tailwind + shadcn/ui (dashboard) · npm workspaces · **no Docker, no Turborepo,
no microservices** — modular monolith.

## Layout

```
apps/        api · worker · dashboard          (independent deploy targets)
packages/    domain · database · events · ingestion · agents · brain ·
             signals · predictions · evaluation · paper-engine · llm
openspec/    AGENTS.md · specs/ · changes/ · archive/
docs/        architecture · agents · brain · scoring · research · decisions
scripts/     seed analysis, backfill, ad-hoc utilities
```

Packages are created as the milestone that needs them lands — not all stubbed up front.

## Current milestone

**M1 — Data Foundation.** Raw external data becomes clean internal events: Solana (Helius) +
Bybit provider adapters, ingestion + normalization, Postgres/Drizzle, Redis/BullMQ, event bus,
and the **core historical replay engine** (moved to M1 — Brain Seeding depends on it).

See [`openspec/changes/`](openspec/changes/) for what's in flight.

## Getting started

```bash
cp .env.example .env      # fill in DATABASE_URL, REDIS_URL, HELIUS_API_KEY, ...
npm install
npm run typecheck
npm test
```
