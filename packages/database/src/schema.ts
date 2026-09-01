/**
 * Drizzle schema — data-foundation slice only (m1-foundation-core).
 *
 * This is NOT the full §13 entity list. Only the tables M1 ingestion + replay
 * touch live here; TradingAgent / Wallet scoring / Signal / Prediction / Brain* /
 * Paper* / ScoringConfig etc. are added by the milestones that own them, so the
 * schema grows with real consumers rather than as one giant upfront guess
 * (CLAUDE.md — "grow an existing one"; design.md — partial-schema decision).
 *
 * Conventions (CLAUDE.md — "Naming"): table + column names snake_case; prices and
 * sizes stored as `numeric` (string in TS) to preserve precision — never floats.
 * Timestamps are timestamptz. Idempotency/correctness is enforced by DB
 * constraints, never application check-then-write (§29, rule 12).
 */
import { pgTable, text, integer, bigint, jsonb, numeric, timestamp, primaryKey, uniqueIndex, index } from 'drizzle-orm/pg-core';

/**
 * Durable log of every event that crossed the bus (§13). Append-only.
 * Indexed by (type, event_time) for "what happened, of this kind, up to T" scans.
 */
export const domainEvent = pgTable(
  'domain_event',
  {
    id: text('id').primaryKey(), // uuid v4 — the idempotency key (§29)
    type: text('type').notNull(),
    version: integer('version').notNull().default(1),
    eventTime: timestamp('event_time', { withTimezone: true, mode: 'date' }).notNull(),
    processingTime: timestamp('processing_time', { withTimezone: true, mode: 'date' }).notNull(),
    source: text('source').notNull(),
    correlationId: text('correlation_id'),
    payload: jsonb('payload').notNull(),
  },
  (t) => [index('domain_event_type_time_idx').on(t.type, t.eventTime)],
);

/**
 * The idempotency ledger (§29). A consumer claims an event by inserting its id
 * here inside the same transaction as its effects; a unique-violation means
 * "already processed → skip". This is the structural enforcement of at-least-once
 * → exactly-once, never a check-then-write.
 */
export const processedEvent = pgTable('processed_event', {
  eventId: text('event_id').primaryKey(),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * The unified historical + live candle store (§25). Live WS closed candles and
 * the Bybit backfill both write here — "the historical store and the live store
 * are one table, just continuously extended." Composite PK gives both uniqueness
 * (backfill re-runs are idempotent) and the chronological range-scan index.
 */
export const marketCandle = pgTable(
  'market_candle',
  {
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    openTime: timestamp('open_time', { withTimezone: true, mode: 'date' }).notNull(),
    closeTime: timestamp('close_time', { withTimezone: true, mode: 'date' }).notNull(),
    open: numeric('open').notNull(),
    high: numeric('high').notNull(),
    low: numeric('low').notNull(),
    close: numeric('close').notNull(),
    volume: numeric('volume').notNull(),
    turnover: numeric('turnover'),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.timeframe, t.openTime] })],
);

/** Funding-rate history (§Part III §5). One row per symbol per funding stamp. */
export const fundingRate = pgTable(
  'funding_rate',
  {
    symbol: text('symbol').notNull(),
    fundingTime: timestamp('funding_time', { withTimezone: true, mode: 'date' }).notNull(),
    rate: numeric('rate').notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.fundingTime] })],
);

/** Open-interest history (§Part III §5). One row per symbol per snapshot. */
export const openInterest = pgTable(
  'open_interest',
  {
    symbol: text('symbol').notNull(),
    snapshotTime: timestamp('snapshot_time', { withTimezone: true, mode: 'date' }).notNull(),
    oi: numeric('oi').notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.snapshotTime] })],
);

/**
 * Normalized on-chain wallet action (§13). Provider-specific shapes never reach
 * here (§12) — the Helius adapter normalizes first. `tx_hash` unique is the §29
 * dedup example: the same signature arriving twice is rejected by the DB.
 */
export const walletTransaction = pgTable(
  'wallet_transaction',
  {
    id: text('id').primaryKey(), // uuid v4
    wallet: text('wallet').notNull(),
    action: text('action').notNull(), // 'BUY' | 'SELL'
    mint: text('mint').notNull(),
    // Deterministic on-chain amounts captured at ingestion (m1-helius-adapter):
    amountSol: numeric('amount_sol').notNull().default('0'), // quote (SOL) leg of the swap
    tokenAmount: numeric('token_amount').notNull().default('0'), // target token, UI-adjusted
    // USD valuation is an M2 enrichment (SOL-price join) — null until then.
    amountUsd: numeric('amount_usd'),
    blockTime: timestamp('block_time', { withTimezone: true, mode: 'date' }).notNull(),
    txHash: text('tx_hash').notNull(),
    slot: bigint('slot', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('wallet_transaction_tx_hash_uq').on(t.txHash),
    index('wallet_transaction_wallet_time_idx').on(t.wallet, t.blockTime),
  ],
);

/** Continuously-updated token profile (§Part II §6). Keyed by mint, upserted on sight. */
export const token = pgTable('token', {
  mint: text('mint').primaryKey(),
  symbol: text('symbol'),
  name: text('name'),
  decimals: integer('decimals'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

export const schema = {
  domainEvent,
  processedEvent,
  marketCandle,
  fundingRate,
  openInterest,
  walletTransaction,
  token,
};
