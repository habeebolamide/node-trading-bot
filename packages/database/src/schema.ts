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

/**
 * Watchlist (m3-watchlist). Wallets the OPERATOR chose to actively monitor. Distinct from
 * `wallet` — that's the platform-wide profile (anyone we've scored); `watched_wallet` is the
 * subscription set the Helius webhook targets. `unwatched_at` is soft-delete: a wallet can be
 * watched → unwatched → re-watched and the history stays queryable. Active = unwatched_at IS NULL.
 */
export const watchedWallet = pgTable('watched_wallet', {
  address: text('address').primaryKey(),
  note: text('note'),
  watchedAt: timestamp('watched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  unwatchedAt: timestamp('unwatched_at', { withTimezone: true, mode: 'date' }),
});

/**
 * A wallet's first-hop SOL funder (m3-funder-clustering, Part II §5 interim heuristic). Cached
 * once — a wallet's original funder doesn't change. `inferred_at_cap` = we hit the paging cap
 * before reaching genesis; the oldest transfer we DID see is stored, flagged so downstream can
 * apply a wider window if it wants.
 */
export const walletFunder = pgTable(
  'wallet_funder',
  {
    walletId: text('wallet_id').primaryKey(),
    funderAddress: text('funder_address').notNull(),
    fundedAt: timestamp('funded_at', { withTimezone: true, mode: 'date' }).notNull(),
    fundedSol: numeric('funded_sol').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    inferredAtCap: boolean('inferred_at_cap').notNull().default(false),
  },
  (t) => [index('wallet_funder_funder_idx').on(t.funderAddress)],
);

/**
 * One clustering pass. Versioned by run — every recompute writes a new run and flips prior
 * runs' `status` from 'active' to 'superseded' in one transaction, so readers joining on
 * `status='active'` never see partial data mid-flight.
 */
export const clusterRun = pgTable('cluster_run', {
  runId: text('run_id').primaryKey(),
  runAt: timestamp('run_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  windowHours: integer('window_hours').notNull(),
  walletCount: integer('wallet_count').notNull(),
  clusterCount: integer('cluster_count').notNull(),
  status: text('status').notNull().default('active'), // 'active' | 'superseded'
});

/**
 * Cluster membership: `cluster_id` is shared across all members of one cluster within a run.
 * Convergence readers (change 3) join here to `cluster_run.status='active'`.
 */
export const walletCluster = pgTable(
  'wallet_cluster',
  {
    id: text('id').primaryKey(),
    clusterId: text('cluster_id').notNull(),
    walletId: text('wallet_id').notNull(),
    clusterRunId: text('cluster_run_id').notNull(),
    clusteredAt: timestamp('clustered_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('wallet_cluster_run_cluster_idx').on(t.clusterRunId, t.clusterId),
    index('wallet_cluster_wallet_run_idx').on(t.walletId, t.clusterRunId),
  ],
);

/**
 * TradingAgent (m4-tradingagent, §14) — user-created strategy entity. Identity
 * (`{ id, domain, universe, tradingStyle }`) is immutable per §8/Task 1; everything tunable
 * lives in the versioned `scoringConfig` table this points at. `active_config_version` FKs
 * the current active row (see below).
 */
export const tradingAgent = pgTable('trading_agent', {
  id: text('id').primaryKey(), // uuid
  name: text('name').notNull(),
  domain: text('domain').notNull(), // 'perp' | 'memecoin'
  universe: text('universe').array().notNull(),
  tradingStyle: text('trading_style').notNull(), // 'scalp' | 'day' | 'swing'
  activeConfigVersion: integer('active_config_version').notNull(),
  status: text('status').notNull().default('active'), // 'active' | 'blocked' | 'archived'
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * ScoringConfig (§8/§16) — APPEND-ONLY, versioned per TradingAgent. A promoted change writes a
 * new row (never mutates); every Prediction / Signal FKs the specific `version` that produced
 * it, so weight changes never silently blend track records (§33 rule 16).
 */
export const scoringConfig = pgTable(
  'scoring_config',
  {
    id: text('id').primaryKey(), // uuid
    tradingAgentId: text('trading_agent_id').notNull(),
    version: integer('version').notNull(),
    config: jsonb('config').notNull(), // full §8 schema (weights, thresholds, memecoin fields)
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('scoring_config_agent_version_uq').on(t.tradingAgentId, t.version)],
);

/**
 * AgentPerformance skeleton (§16/Task-1). Populated as M6 Predictions resolve; per-TradingAgent
 * per-Agent track record keyed by (agent_key, agent_version). Empty at M4 — the framework
 * writes the initial row-shapes for M6 to update.
 */
export const agentPerformance = pgTable(
  'agent_performance',
  {
    id: text('id').primaryKey(),
    tradingAgentId: text('trading_agent_id').notNull(),
    agentKey: text('agent_key').notNull(),
    agentVersion: integer('agent_version').notNull(),
    wins: integer('wins').notNull().default(0),
    losses: integer('losses').notNull().default(0),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_performance_key_uq').on(t.tradingAgentId, t.agentKey, t.agentVersion)],
);

/**
 * BrainAgentMemory skeleton (§16 — standalone counterfactual accuracy per Agent, DOMAIN-wide).
 * Populated in M5; empty at M4.
 */
export const brainAgentMemory = pgTable(
  'brain_agent_memory',
  {
    id: text('id').primaryKey(),
    domain: text('domain').notNull(),
    agentKey: text('agent_key').notNull(),
    agentVersion: integer('agent_version').notNull(),
    standaloneAccuracy: numeric('standalone_accuracy'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('brain_agent_memory_key_uq').on(t.domain, t.agentKey, t.agentVersion)],
);

/**
 * Signal (m4-signal-engine, §9, §36). Immutable after CONSUMED — but state field mutates through
 * the §36 lifecycle (ACTIVE → EXPIRED/INVALIDATED/CONSUMED). `fingerprint` is a hash of
 * (tradingAgentId, symbol, direction, tfCloseMinute) so re-arrivals within one candle dedup at
 * the DB level (§9 correlation). `config_version` FKs the ScoringConfig row that produced it —
 * rule 16, so a promoted weight change doesn't silently blend track records (§19 rule 10).
 */
export const signal = pgTable(
  'signal',
  {
    id: text('id').primaryKey(),
    tradingAgentId: text('trading_agent_id').notNull(),
    symbol: text('symbol').notNull(),
    domain: text('domain').notNull(),
    direction: text('direction').notNull(), // STRONG_LONG | ... | STRONG_SHORT | NEUTRAL
    compositeScore: numeric('composite_score').notNull(),
    confidence: numeric('confidence').notNull(),
    state: text('state').notNull().default('ACTIVE'), // ACTIVE | EXPIRED | INVALIDATED | CONSUMED
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    configVersion: integer('config_version').notNull(),
    fingerprint: text('fingerprint').notNull(),
    evidence: jsonb('evidence').notNull(), // { agentAgreement, dataQuality, subMetrics, ... }
  },
  (t) => [
    uniqueIndex('signal_fingerprint_uq').on(t.fingerprint),
    index('signal_agent_state_idx').on(t.tradingAgentId, t.state),
  ],
);

/**
 * signal_feature — per-agent contribution to a Signal (§22 attribution). One row per
 * (signal, agent, agentVersion). Populated in the same transaction as the Signal insert.
 */
export const signalFeature = pgTable(
  'signal_feature',
  {
    signalId: text('signal_id').notNull(),
    agentKey: text('agent_key').notNull(),
    agentVersion: integer('agent_version').notNull(),
    score: numeric('score').notNull(),
    confidence: numeric('confidence').notNull(),
    features: jsonb('features').notNull(),
  },
  (t) => [primaryKey({ columns: [t.signalId, t.agentKey, t.agentVersion] })],
);

/**
 * signal_risk (m4-risk-agent, §40.12). One row per scored Signal: the Risk Agent's verdict
 * (level + flags). `INVALIDATED` risk_level is the trigger for transitioning the parent Signal
 * to INVALIDATED (§36). Even LOW gets a row — dashboards want the full breakdown.
 */
export const signalRisk = pgTable('signal_risk', {
  signalId: text('signal_id').primaryKey(),
  riskLevel: text('risk_level').notNull(), // LOW | MEDIUM | MEDIUM_HIGH | HIGH | INVALIDATED
  riskFlags: text('risk_flags').array().notNull().default([]),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  agentVersion: integer('agent_version').notNull(),
});

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
  watchedWallet,
  walletFunder,
  clusterRun,
  walletCluster,
  tradingAgent,
  scoringConfig,
  agentPerformance,
  brainAgentMemory,
  signal,
  signalFeature,
  signalRisk,
};
