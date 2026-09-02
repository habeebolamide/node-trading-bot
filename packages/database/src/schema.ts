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

/**
 * Per-wallet Brain memory (§16, Part II §8 Wallet Memory, §40.17).
 *
 * `earlyEntry` (M2) holds the forward-return aggregates. `behavior` (m5-wallet-token-memory) is
 * the BEHAVIORAL PROFILE that explains the score and feeds the Judge's evidence package — the
 * score itself stays in the append-only `wallet_score_event` log (§4, rule 21), never here.
 */
export const brainWalletMemory = pgTable('brain_wallet_memory', {
  walletId: text('wallet_id').primaryKey(),
  earlyEntry: jsonb('early_entry'), // { perHorizonMedian{}, peakMedian, coverage }
  // { medianHoldMinutes, avgPositionSol, tradesPerDay, specialization{}, clusterAffiliations[],
  //   effectiveN, rated } — 60d half-life (Task 6 wallet metric).
  behavior: jsonb('behavior'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * BrainTokenMemory (m5-wallet-token-memory, §13, Part II §8 Token Memory, Part II §6).
 *
 * Task 6 fixes the token score inputs: liquidity / age / holder-concentration / volume,
 * percentile-normalized. SAFETY IS NOT A SOFT INPUT here — Token Risk (§40.13) is a hard gate
 * built at M4 and untouched by this table.
 *
 * `score` is null when inputs are missing or the observed universe is too thin to percentile
 * against; a fabricated percentile is worse than no score. `outcomes` reuses the same
 * `wilsonInterval` + recency weighting as Setup Memory — one statistics implementation,
 * everywhere (§41).
 */
export const brainTokenMemory = pgTable('brain_token_memory', {
  mint: text('mint').primaryKey(),
  domain: text('domain').notNull().default('memecoin'),
  profile: jsonb('profile').notNull(), // { liquidityUsd, ageMinutes, top10HolderPct, volume24hUsd }
  score: numeric('score'), // percentile-normalized composite; null when un-scoreable
  outcomes: jsonb('outcomes'), // { effectiveN, winRate, medianReturn, wilsonLower, wilsonUpper }
  evidence: text('evidence').notNull().default('INSUFFICIENT'),
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
/**
 * AgentPerformance (m4-tradingagent, §13). PER-TRADINGAGENT win/loss counters for an Analysis
 * Agent, keyed `(tradingAgentId, agentKey, agentVersion)`.
 *
 * NOT the same thing as `brain_agent_memory` below — §16 warns that "how useful has this agent
 * been" collapses into Attribution and hypothesis promotion unless the mechanism is pinned down.
 * The split:
 *   agent_performance   → "inside THIS TradingAgent's composite, how did this agent fare?"
 *   brain_agent_memory  → "DOMAIN-WIDE, if a hypothetical agent had followed ONLY this agent's
 *                          lean and ignored every other, what would its win rate have been?"
 * Different key, different question. Never blend them.
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
 * BrainAgentMemory (m5-agent-memory, §16). DOMAIN-WIDE standalone counterfactual accuracy:
 * "if a hypothetical TradingAgent had followed ONLY this one agent's lean, direction-for-
 * direction, ignoring every other agent, what would its win rate have been?"
 *
 * §16 is emphatic that this is DESCRIPTIVE, NOT PRESCRIPTIVE — it changes no weight by itself.
 * It is the diagnostic that would motivate someone to PROPOSE a hypothesis (§24), and the number
 * that would justify deprecating an agent whose standalone accuracy sat at chance for long
 * enough. There is deliberately no code path from this table to a ScoringConfig write.
 *
 * Keyed `(domain, agentKey, agentVersion)` — versions NEVER blend (CLAUDE.md "do not blend
 * versions"). A v1→v2 bump starts a fresh track record; there is no roll-up-across-versions
 * accessor, because that convenience is exactly how a regression hides behind an old version's
 * good numbers.
 *
 * The `vetoed*` columns are the Risk Agent's separate veto-accuracy metric ("when we invalidated
 * a signal, would it actually have lost?"). Answerable only against M7 shadow predictions, so
 * the shape is recorded here and stays null until then — that keeps M4's `signal_risk` rows from
 * being write-only.
 */
export const brainAgentMemory = pgTable(
  'brain_agent_memory',
  {
    id: text('id').primaryKey(),
    domain: text('domain').notNull(),
    agentKey: text('agent_key').notNull(),
    agentVersion: integer('agent_version').notNull(),
    standaloneAccuracy: numeric('standalone_accuracy'),
    effectiveN: numeric('effective_n').notNull().default('0'),
    effectiveWins: numeric('effective_wins').notNull().default('0'),
    wilsonLower: numeric('wilson_lower'),
    wilsonUpper: numeric('wilson_upper'),
    evidence: text('evidence').notNull().default('INSUFFICIENT'),
    occurrenceCount: integer('occurrence_count').notNull().default(0),
    sampleSince: timestamp('sample_since', { withTimezone: true, mode: 'date' }),
    // Risk Agent veto accuracy — populated at M7 against shadow predictions.
    vetoedCount: integer('vetoed_count'),
    vetoedWouldHaveLost: integer('vetoed_would_have_lost'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('brain_agent_memory_key_uq').on(t.domain, t.agentKey, t.agentVersion)],
);

/**
 * BrainAgentOccurrence (m5-agent-memory). Append-only counterfactual log — one row per
 * (resolved prediction × contributing agent). Same shape and rationale as
 * `brain_setup_occurrence`: rule 8 makes these immutable outcome facts, and
 * `unique(prediction_id, agent_key, agent_version)` is the rule-12 idempotency guard so a
 * redelivered outcome event cannot double-count.
 *
 * `lean` is the agent's OWN signed direction (+1 / −1), not the composite's — the whole point of
 * §16's mechanism is that an agent which dissented from a losing composite gets credited.
 */
export const brainAgentOccurrence = pgTable(
  'brain_agent_occurrence',
  {
    id: text('id').primaryKey(),
    domain: text('domain').notNull(),
    agentKey: text('agent_key').notNull(),
    agentVersion: integer('agent_version').notNull(),
    predictionId: text('prediction_id').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }).notNull(),
    lean: integer('lean').notNull(), // +1 | -1 (0-lean agents are not recorded at all)
    won: boolean('won').notNull(),
  },
  (t) => [
    uniqueIndex('brain_agent_occurrence_pred_agent_uq').on(t.predictionId, t.agentKey, t.agentVersion),
    index('brain_agent_occurrence_agent_idx').on(t.domain, t.agentKey, t.agentVersion),
  ],
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



/**
 * signal_no_trade (m6-predictions). When the Trade Planner returns a NO_TRADE, we record WHY
 * against the signal rather than creating a Prediction — §19 defines a Prediction as carrying an
 * entry reference and a horizon, which a veto doesn't have. This keeps §22 attribution and §32
 * denominators honest: metrics measure trades actually taken, and the R:R gate's own accuracy
 * becomes a separate M7 question against §18 shadow predictions.
 */
export const signalNoTrade = pgTable('signal_no_trade', {
  signalId: text('signal_id').primaryKey(),
  reason: text('reason').notNull(), // INSUFFICIENT_RR | CANNOT_SIZE_SAFELY | NO_STOP_DERIVABLE | STALE_OR_MISSING_DATA
  detail: text('detail'),
  vetoedAt: timestamp('vetoed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * Prediction (§19, m6-predictions). IMMUTABLE after creation (rule 10) — enforced by a Postgres
 * trigger appended in the migration, not by convention. If a schema field seems to want UPDATE,
 * you're modelling it wrong (rule 10).
 *
 * `config_version` is a MANDATORY FK to the exact scoring_config that produced it (§19, rule 16).
 * Without it a promoted §24 hypothesis silently blends predictions made under two configs into
 * one number and destroys the "did the weight change actually help" question.
 *
 * `signal_id` is unique — one signal → at most one prediction (§36 CONSUMED transition).
 * `is_shadow` / `shadow_of` land here for §18's Judge-override machinery (M7); no writer creates
 * shadow rows yet.
 */
export const prediction = pgTable(
  'prediction',
  {
    id: text('id').primaryKey(),
    tradingAgentId: text('trading_agent_id').notNull(),
    signalId: text('signal_id').notNull(),
    domain: text('domain').notNull(),
    symbol: text('symbol').notNull(),
    direction: text('direction').notNull(),
    score: numeric('score').notNull(),
    confidence: numeric('confidence').notNull(),
    horizon: text('horizon').notNull(),
    entry: numeric('entry').notNull(),
    stopLoss: numeric('stop_loss').notNull(),
    takeProfit: numeric('take_profit'), // null when a memecoin ladder is configured
    positionSize: numeric('position_size').notNull(),
    notional: numeric('notional').notNull(),
    leverage: numeric('leverage'),          // perp only
    requiredMargin: numeric('required_margin'),
    riskReward: numeric('risk_reward').notNull(),
    thesis: text('thesis'),                 // M7 (Judge) fills; null is valid
    features: jsonb('features').notNull(),  // agent contributions — §22 attribution input
    invalidators: jsonb('invalidators'),
    configVersion: integer('config_version').notNull(),
    isShadow: boolean('is_shadow').notNull().default(false),
    shadowOf: text('shadow_of'),            // FK-shaped to prediction(id); M7 populates
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('prediction_signal_uq').on(t.signalId),
    index('prediction_agent_created_idx').on(t.tradingAgentId, t.createdAt),
  ],
);

/**
 * PredictionOutcome (§21, m6-outcome-engine will fill this). One row per (prediction, horizon).
 * Deliberately NOT trigger-locked like `prediction` — it accrues per horizon as each elapses.
 * The CLAIM is frozen; the MEASUREMENT builds up over time.
 *
 * `outcome_resolution` (TICK | CANDLE_1M_CONSERVATIVE, §21) keeps live and seeded populations
 * separable in reporting forever even though the Brain aggregates them together.
 */
export const predictionOutcome = pgTable(
  'prediction_outcome',
  {
    predictionId: text('prediction_id').notNull(),
    horizon: text('horizon').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }).notNull(),
    returnPct: numeric('return_pct').notNull(),
    benchmarkReturnPct: numeric('benchmark_return_pct'),
    alpha: numeric('alpha'),
    mfe: numeric('mfe'),
    mae: numeric('mae'),
    hitTarget: boolean('hit_target').notNull().default(false),
    hitInvalidation: boolean('hit_invalidation').notNull().default(false),
    holdingPeriodSec: bigint('holding_period_sec', { mode: 'number' }),
    won: boolean('won').notNull(),
    outcomeResolution: text('outcome_resolution').notNull(),
  },
  (t) => [primaryKey({ columns: [t.predictionId, t.horizon] })],
);

/**
 * BrainSetupOccurrence (m5-brain-core, §41). Append-only log — one row per closed prediction
 * per fingerprint rung. History is NEVER deleted (Part II §8: "older occurrences count less,
 * not deleted — the full history stays queryable, only its influence on the current live
 * estimate decays"). Rule 8.
 *
 * `unique(prediction_id, setup_id)` is the rule-12 idempotency guard: a replayed outcome event
 * is a DB-level no-op, not an application-side check-then-write (§29). The pair, not
 * prediction_id alone, because m5-historical-edge writes the same prediction to each coarser
 * backoff rung.
 */
export const brainSetupOccurrence = pgTable(
  'brain_setup_occurrence',
  {
    id: text('id').primaryKey(), // uuid
    setupId: text('setup_id').notNull(),
    predictionId: text('prediction_id').notNull(),
    domain: text('domain').notNull(), // perp | memecoin
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }).notNull(),
    won: boolean('won').notNull(),
    returnPct: numeric('return_pct').notNull(),
  },
  (t) => [
    uniqueIndex('brain_setup_occurrence_pred_setup_uq').on(t.predictionId, t.setupId),
    index('brain_setup_occurrence_setup_idx').on(t.setupId),
  ],
);

/**
 * BrainSetupMemory (m5-brain-core, §13, Part II §8, §41). The DERIVED live aggregate for one
 * fingerprint — recomputed and upserted on every close. Upserting is not a rule-8 violation:
 * the occurrence log above is the immutable history, this row is the decayed live estimate
 * §41 describes.
 *
 * `effectiveWins` is stored alongside `winRate` deliberately (§41 implementer note) — it's
 * what lets Wilson be re-derived at a different confidence level later; winRate is the
 * convenience field derivable from the two effective* values.
 *
 * Wilson bounds are NULL while `evidence = INSUFFICIENT` (effective-n < 10). Parent-bucket
 * backoff is a READ-side concern and never writes fallback stats here (§41).
 */
export const brainSetupMemory = pgTable('brain_setup_memory', {
  setupId: text('setup_id').primaryKey(),
  domain: text('domain').notNull(),
  effectiveN: numeric('effective_n').notNull(),
  effectiveWins: numeric('effective_wins').notNull(),
  winRate: numeric('win_rate'),
  medianReturn: numeric('median_return'),
  wilsonLower: numeric('wilson_lower'),
  wilsonUpper: numeric('wilson_upper'),
  evidence: text('evidence').notNull(), // SUFFICIENT | INSUFFICIENT
  occurrenceCount: integer('occurrence_count').notNull().default(0),
  lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});



/**
 * Paper Engine tables (m6-paper-engine, §13 / §20 / Part II §10). Virtual cash and positions —
 * the answer to "what would have happened if we took it?" No real-money execution anywhere in
 * this codebase (rule 20).
 *
 * `paper_position.opened_at_event` / `opened_at_processing` are §20's "record both clocks"
 * mandate — reaction lag becomes a measured number, not a guess, and every fill row carries
 * both too. Prevents the memecoin sell-side P&L from flattering itself in exactly the scenario
 * that hurts most in real trading (§20).
 */
export const paperPortfolio = pgTable('paper_portfolio', {
  id: text('id').primaryKey(),
  tradingAgentId: text('trading_agent_id').notNull(),
  startingCash: numeric('starting_cash').notNull(),
  cash: numeric('cash').notNull(),
  equity: numeric('equity').notNull(),
  peakEquity: numeric('peak_equity').notNull(),
  maxDrawdown: numeric('max_drawdown').notNull().default('0'),
  realizedPnl: numeric('realized_pnl').notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const paperPosition = pgTable(
  'paper_position',
  {
    id: text('id').primaryKey(),
    portfolioId: text('portfolio_id').notNull(),
    predictionId: text('prediction_id').notNull(),
    symbol: text('symbol').notNull(),
    domain: text('domain').notNull(),
    direction: text('direction').notNull(), // LONG | SHORT
    state: text('state').notNull().default('OPEN'), // OPEN | CLOSED
    entryPrice: numeric('entry_price').notNull(),
    size: numeric('size').notNull(),
    remainingSize: numeric('remaining_size').notNull(),
    currentStop: numeric('current_stop').notNull(),
    takeProfit: numeric('take_profit'),
    /** Ladder state (Part II §10): { firedRungs: number[], trailStopPct?: number }. */
    ladderState: jsonb('ladder_state'),
    /** Both clocks at open (§20). */
    openedAtEvent: timestamp('opened_at_event', { withTimezone: true, mode: 'date' }).notNull(),
    openedAtProcessing: timestamp('opened_at_processing', { withTimezone: true, mode: 'date' }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    closeReason: text('close_reason'),
    realizedPnl: numeric('realized_pnl').notNull().default('0'),
    mfe: numeric('mfe').notNull().default('0'),
    mae: numeric('mae').notNull().default('0'),
  },
  (t) => [
    uniqueIndex('paper_position_prediction_uq').on(t.predictionId),
    index('paper_position_portfolio_state_idx').on(t.portfolioId, t.state),
  ],
);

export const paperPositionFill = pgTable(
  'paper_position_fill',
  {
    id: text('id').primaryKey(),
    positionId: text('position_id').notNull(),
    /** Both clocks per §20 — reaction lag is a measured number, not a guess. */
    fillAtEvent: timestamp('fill_at_event', { withTimezone: true, mode: 'date' }).notNull(),
    fillAtProcessing: timestamp('fill_at_processing', { withTimezone: true, mode: 'date' }).notNull(),
    /** Fraction of the ORIGINAL entry notional filled by this row (Part II §10). */
    sizeFraction: numeric('size_fraction').notNull(),
    price: numeric('price').notNull(),
    /** ENTRY | LADDER_RUNG_N | STOP_LOSS | WALLET_EXIT | TAKE_PROFIT | HORIZON */
    reason: text('reason').notNull(),
    isFinal: boolean('is_final').notNull().default(false),
  },
  (t) => [index('paper_position_fill_position_idx').on(t.positionId)],
);

/**
 * Originating-wallet join (Part II §10). One row per wallet that contributed to a memecoin
 * entry signal. `entry_score` is the point-in-time wallet score (rule 21) — read via
 * `walletScoreAsOf`, never live. `current_held_fraction` decrements as the wallet sells; the
 * `walletExitThreshold` accumulator sums `(1 − current_held_fraction) × entry_weight` across
 * rows. Retained after position close for autopsy and attribution.
 */
export const paperPositionOriginatingWallet = pgTable(
  'paper_position_originating_wallet',
  {
    positionId: text('position_id').notNull(),
    walletId: text('wallet_id').notNull(),
    clusterId: text('cluster_id'),
    entryUsd: numeric('entry_usd').notNull().default('0'),
    /** Contribution weight into the exit accumulator (cluster-weighted, §5 funder dedup). */
    entryWeight: numeric('entry_weight').notNull(),
    /** Point-in-time wallet score at entry — rule 21. */
    entryScore: numeric('entry_score'),
    currentHeldFraction: numeric('current_held_fraction').notNull().default('1'),
  },
  (t) => [primaryKey({ columns: [t.positionId, t.walletId] })],
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
  brainSetupOccurrence,
  brainSetupMemory,
  brainTokenMemory,
  brainAgentOccurrence,
  signalNoTrade,
  prediction,
  predictionOutcome,
  paperPortfolio,
  paperPosition,
  paperPositionFill,
  paperPositionOriginatingWallet,
};
