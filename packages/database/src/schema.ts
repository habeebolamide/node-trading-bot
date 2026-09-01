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
import { pgTable, text, integer, bigint, boolean, jsonb, numeric, timestamp, primaryKey, uniqueIndex, index } from 'drizzle-orm/pg-core';

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

/**
 * Reconstructed round-trip trade (m2-trade-reconstruction, §13 WalletTrade). Not an immutable
 * fact like a Prediction — it's a deterministic VIEW over `wallet_transaction`, recomputed
 * (delete-then-insert per wallet+mint) whenever that wallet's swaps change. Realized return is
 * SOL-denominated. A position still held at reconstruction time stays status=OPEN (no outcome).
 */
export const walletTrade = pgTable(
  'wallet_trade',
  {
    id: text('id').primaryKey(), // uuid v4
    wallet: text('wallet').notNull(),
    mint: text('mint').notNull(),
    status: text('status').notNull(), // 'OPEN' | 'CLOSED'
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }), // null while OPEN
    buyCount: integer('buy_count').notNull(),
    sellCount: integer('sell_count').notNull(),
    totalSolIn: numeric('total_sol_in').notNull(),
    totalSolOut: numeric('total_sol_out').notNull(),
    tokensBought: numeric('tokens_bought').notNull(),
    tokensSold: numeric('tokens_sold').notNull(),
    realizedReturnPct: numeric('realized_return_pct'), // null while OPEN
    won: boolean('won'), // null while OPEN
    holdingPeriodSec: bigint('holding_period_sec', { mode: 'number' }), // null while OPEN
    flags: text('flags').array().notNull().default([]),
  },
  (t) => [
    index('wallet_trade_wallet_mint_idx').on(t.wallet, t.mint),
    index('wallet_trade_wallet_opened_idx').on(t.wallet, t.openedAt),
  ],
);

/** Wallet profile (§13). Identity + current rating status; the score itself lives in the log below. */
export const wallet = pgTable('wallet', {
  address: text('address').primaryKey(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  lastScoredAt: timestamp('last_scored_at', { withTimezone: true, mode: 'date' }),
  tradeCount: integer('trade_count').notNull().default(0), // CLOSED round-trips
  status: text('status').notNull().default('unrated'), // 'rated' | 'unrated'
});

/**
 * Append-only wallet-score log (§4, rules 8/16/21). "Score as of T" = the latest row with
 * timestamp ≤ T. Never updated in place; a recompute writes a new row. `configVersion` pins the
 * WalletScoringConfig that produced it so a weight change never blends history.
 */
export const walletScoreEvent = pgTable(
  'wallet_score_event',
  {
    id: text('id').primaryKey(), // uuid
    walletId: text('wallet_id').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true, mode: 'date' }).notNull(),
    score: numeric('score').notNull(),
    configVersion: integer('config_version').notNull(),
    inputsUsed: jsonb('inputs_used').notNull(), // raw sub-metrics + percentiles that produced the score
  },
  (t) => [index('wallet_score_event_wallet_ts_idx').on(t.walletId, t.timestamp)],
);

/** Per-wallet Brain memory (§16, §40.17). Holds early-entry aggregate stats + behavioral profile. */
export const brainWalletMemory = pgTable('brain_wallet_memory', {
  walletId: text('wallet_id').primaryKey(),
  earlyEntry: jsonb('early_entry'), // { perHorizonMedian{}, peakMedian, coverage }
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * Wallet-scoring config (§4/Task-1). Append-only, versioned — DOMAIN-LEVEL (a wallet score is a
 * shared Brain fact, §15), distinct from the per-TradingAgent ScoringConfig (§8). Weight changes
 * write a new row; every WalletScoreEvent FKs the version that produced it.
 */
export const walletScoringConfig = pgTable('wallet_scoring_config', {
  version: integer('version').primaryKey(),
  weights: jsonb('weights').notNull(), // {profitability, winRate, earlyEntry, consistency, specialization, tradeQuality, corroboration}
  priorAlpha: numeric('prior_alpha').notNull(),
  priorBeta: numeric('prior_beta').notNull(),
  unratedMinTrades: integer('unrated_min_trades').notNull().default(10),
  recomputeEveryNTrades: integer('recompute_every_n_trades').notNull().default(25),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  active: boolean('active').notNull().default(true),
});

/**
 * Per-trade forward-horizon returns (§3/§13) computed via the observed-swap price approximation.
 * `forwardReturns` holds `{ '5m': number|null, … }` — null where no swap landed near the horizon
 * (never fabricated). `coverage` = fraction of horizons with data, used to down-weight thin stats.
 */
export const tradeOutcome = pgTable(
  'trade_outcome',
  {
    id: text('id').primaryKey(), // uuid
    tradeId: text('trade_id').notNull(),
    walletId: text('wallet_id').notNull(),
    mint: text('mint').notNull(),
    entryAt: timestamp('entry_at', { withTimezone: true, mode: 'date' }).notNull(),
    entryPriceSol: numeric('entry_price_sol').notNull(),
    forwardReturns: jsonb('forward_returns').notNull(),
    peakReturn: numeric('peak_return'),
    coverage: numeric('coverage').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('trade_outcome_wallet_idx').on(t.walletId)],
);

export const schema = {
  domainEvent,
  processedEvent,
  marketCandle,
  fundingRate,
  openInterest,
  walletTransaction,
  token,
  walletTrade,
  wallet,
  walletScoreEvent,
  brainWalletMemory,
  walletScoringConfig,
  tradeOutcome,
};
