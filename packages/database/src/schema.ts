import {
  pgTable,
  bigint,
  boolean,
  bigserial,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  uniqueIndex,
  unique,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
const time = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();
export const users = pgTable('app_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: time('created_at'),
});
export const accounts = pgTable(
  'exchange_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .unique()
      .references(() => users.id),
    name: text('name').notNull(),
    environment: text('environment').notNull().default('PAPER'),
    equityBaseline: numeric('equity_baseline', { precision: 38, scale: 18 })
      .notNull()
      .default('100'),
    currency: text('currency').notNull().default('USDT'),
    createdAt: time('created_at'),
  },
  (t) => [
    check('account_paper_only', sql`${t.environment} = 'PAPER'`),
    check('positive_baseline', sql`${t.equityBaseline} > 0`),
  ],
);
export const tokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    role: text('role').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: time('created_at'),
  },
  (t) => [check('token_role', sql`${t.role} IN ('OWNER','VIEWER')`)],
);
export const strategies = pgTable('strategies', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
});
export const strategyVersions = pgTable(
  'strategy_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id),
    version: text('version').notNull(),
    status: text('status').notNull().default('DRAFT'),
    requirements: jsonb('requirements').notNull(),
    codeHash: text('code_hash'),
    createdAt: time('created_at'),
  },
  (t) => [
    uniqueIndex('strategy_version_unique').on(t.strategyId, t.version),
    check('strategy_status', sql`${t.status} IN ('DRAFT','VALIDATED')`),
  ],
);
export const bots = pgTable(
  'bots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('exchange_account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    canonicalMarketId: text('canonical_market_id').notNull(),
    market: jsonb('market').notNull(),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    executionMode: text('execution_mode').notNull().default('PAPER'),
    riskProfile: text('risk_profile').notNull().default('CONSERVATIVE'),
    allocationTargetPercent: numeric('allocation_target_percent', {
      precision: 9,
      scale: 6,
    })
      .notNull()
      .default('0'),
    operationalStatus: text('operational_status').notNull().default('STOPPED'),
    tradingState: text('trading_state').notNull().default('IDLE'),
    configVersion: integer('config_version').notNull().default(1),
    version: integer('version').notNull().default(1),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (t) => [
    unique('bot_account_identity').on(t.id, t.accountId),
    check('bot_mode', sql`${t.executionMode} IN ('PAPER','SIGNAL_ONLY')`),
    check(
      'bot_operational_state',
      sql`${t.operationalStatus} IN ('STOPPED','STARTING','WARMING_UP','RUNNING','PAUSED','STOP_REQUESTED','RECONCILING','RISK_SUSPENDED','ERROR')`,
    ),
    check(
      'bot_trading_state',
      sql`${t.tradingState} IN ('IDLE','PENDING_ENTRY','IN_TRADE','CLOSING','UNRESOLVED')`,
    ),
    check(
      'bot_risk_profile',
      sql`${t.riskProfile} IN ('CONSERVATIVE','MODERATE','AGGRESSIVE')`,
    ),
    check(
      'allocation_bounds',
      sql`${t.allocationTargetPercent} >= 0 AND ${t.allocationTargetPercent} <= 80`,
    ),
    check(
      'signal_no_allocation',
      sql`${t.executionMode} <> 'SIGNAL_ONLY' OR ${t.allocationTargetPercent} = 0`,
    ),
    check(
      'positive_versions',
      sql`${t.configVersion} > 0 AND ${t.version} > 0`,
    ),
  ],
);
export const configs = pgTable(
  'bot_config_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id),
    configVersion: integer('config_version').notNull(),
    config: jsonb('config_json').notNull(),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    createdAt: time('created_at'),
  },
  (t) => [uniqueIndex('config_version_unique').on(t.botId, t.configVersion)],
);
export const ownership = pgTable(
  'coin_ownership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('exchange_account_id')
      .notNull()
      .references(() => accounts.id),
    canonicalCoinKey: text('canonical_coin_key').notNull(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id),
    claimedAt: time('claimed_at'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_active_coin_owner')
      .on(t.canonicalCoinKey)
      .where(sql`${t.releasedAt} IS NULL`),
    uniqueIndex('uq_bot_coin_owner')
      .on(t.botId)
      .where(sql`${t.releasedAt} IS NULL`),
    foreignKey({
      columns: [t.botId, t.accountId],
      foreignColumns: [bots.id, bots.accountId],
    }),
    check(
      'canonical_coin_format',
      sql`${t.canonicalCoinKey} ~ '^[A-Z0-9]{2,15}$'`,
    ),
  ],
);
export const audits = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  botId: uuid('bot_id').references(() => bots.id),
  actorId: uuid('actor_id')
    .notNull()
    .references(() => users.id),
  eventType: text('event_type').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  details: jsonb('details').notNull(),
  createdAt: time('created_at'),
});

const millis = (name: string) => bigint(name, { mode: 'number' }).notNull();
const amount = (name: string) =>
  numeric(name, { precision: 38, scale: 18 }).notNull();
export const instruments = pgTable(
  'market_instruments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canonicalMarketId: text('canonical_market_id').notNull().unique(),
    exchange: text('exchange').notNull(),
    marketType: text('market_type').notNull(),
    symbol: text('symbol').notNull(),
    baseAsset: text('base_asset').notNull(),
    quoteAsset: text('quote_asset').notNull(),
    specVersion: text('spec_version').notNull(),
    spec: jsonb('spec_json').notNull(),
    verifiedAt: millis('verified_at'),
    expiresAt: millis('expires_at'),
  },
  (t) => [
    check(
      'instrument_market_type',
      sql`${t.marketType} IN ('SPOT','LINEAR_PERPETUAL')`,
    ),
    check('instrument_expiry', sql`${t.expiresAt}>${t.verifiedAt}`),
  ],
);
export const instrumentVersions = pgTable(
  'instrument_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    specVersion: text('spec_version').notNull(),
    spec: jsonb('spec_json').notNull(),
    observedAt: millis('observed_at'),
  },
  (t) => [
    uniqueIndex('instrument_spec_unique').on(t.instrumentId, t.specVersion),
  ],
);
export const candles = pgTable(
  'candles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    timeframe: text('timeframe').notNull(),
    openTime: millis('open_time'),
    closeTime: millis('close_time'),
    open: amount('open'),
    high: amount('high'),
    low: amount('low'),
    close: amount('close'),
    volume: amount('volume'),
    isClosed: boolean('is_closed').notNull(),
    source: text('source').notNull(),
    observedAt: millis('observed_at'),
    availableAt: millis('available_at'),
  },
  (t) => [
    uniqueIndex('candle_identity').on(t.instrumentId, t.timeframe, t.openTime),
    check(
      'candle_closed_ohlc',
      sql`${t.isClosed}=true AND ${t.open}>0 AND ${t.low}>0 AND ${t.volume}>=0 AND ${t.high}>=greatest(${t.open},${t.close}) AND ${t.low}<=least(${t.open},${t.close}) AND ${t.high}>=${t.low}`,
    ),
    check(
      'candle_time_availability',
      sql`${t.openTime}>=0 AND ${t.closeTime}<=${t.availableAt} AND ${t.availableAt}<=${t.observedAt}`,
    ),
    check(
      'candle_timeframe_alignment',
      sql`CASE ${t.timeframe} WHEN '1m' THEN ${t.closeTime}-${t.openTime}=60000 AND ${t.openTime}%60000=0 WHEN '5m' THEN ${t.closeTime}-${t.openTime}=300000 AND ${t.openTime}%300000=0 WHEN '15m' THEN ${t.closeTime}-${t.openTime}=900000 AND ${t.openTime}%900000=0 WHEN '1h' THEN ${t.closeTime}-${t.openTime}=3600000 AND ${t.openTime}%3600000=0 WHEN '4h' THEN ${t.closeTime}-${t.openTime}=14400000 AND ${t.openTime}%14400000=0 ELSE false END`,
    ),
  ],
);
export const marketGaps = pgTable(
  'market_data_gaps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    stream: text('stream').notNull(),
    startTime: millis('start_time'),
    endTime: millis('end_time'),
    status: text('status').notNull(),
    evidence: jsonb('evidence').notNull(),
    observedAt: millis('observed_at'),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('market_gap_identity').on(
      t.instrumentId,
      t.stream,
      t.startTime,
      t.endTime,
    ),
    check('gap_status', sql`${t.status} IN ('OPEN','RESOLVED','UNCERTAIN')`),
    check('gap_range', sql`${t.endTime}>${t.startTime}`),
  ],
);
export const marketCheckpoints = pgTable('market_checkpoints', {
  streamKey: text('stream_key').primaryKey(),
  instrumentId: uuid('instrument_id')
    .notNull()
    .references(() => instruments.id),
  lastOpenTime: bigint('last_open_time', { mode: 'number' }),
  lastEventTime: bigint('last_event_time', { mode: 'number' }),
  observedAt: millis('observed_at'),
  state: jsonb('state').notNull(),
});

export const evaluations = pgTable(
  'strategy_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    configSnapshotId: uuid('config_snapshot_id')
      .notNull()
      .references(() => configs.id),
    configVersion: integer('config_version').notNull(),
    triggerType: text('trigger_type').notNull(),
    triggerEventKey: text('trigger_event_key').notNull(),
    decision: text('decision').notNull(),
    reasonCode: text('reason_code').notNull(),
    eventTime: millis('event_time'),
    decisionTime: millis('decision_time'),
    snapshot: jsonb('snapshot').notNull(),
    correlationId: uuid('correlation_id').notNull(),
  },
  (t) => [
    uniqueIndex('uq_strategy_eval_event').on(
      t.botId,
      t.strategyVersionId,
      t.triggerType,
      t.triggerEventKey,
    ),
    foreignKey({
      columns: [t.botId, t.accountId],
      foreignColumns: [bots.id, bots.accountId],
    }),
    check(
      'evaluation_decision',
      sql`${t.decision} IN ('LONG','SHORT','NO_TRADE')`,
    ),
    check(
      'evaluation_trigger',
      sql`${t.triggerType} IN ('CANDLE_CLOSE','MARKET_EVENT')`,
    ),
    check(
      'evaluation_time',
      sql`${t.configVersion}>0 AND ${t.eventTime}>=0 AND ${t.decisionTime}>=${t.eventTime}`,
    ),
  ],
);

export const runtimeLeases = pgTable(
  'runtime_leases',
  {
    botId: uuid('bot_id')
      .primaryKey()
      .references(() => bots.id),
    ownerId: uuid('owner_instance_id').notNull(),
    token: bigint('fencing_token', { mode: 'number' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('positive_fence', sql`${t.token}>0`)],
);
export const runtimeCommands = pgTable(
  'runtime_commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sequence: bigserial('sequence', { mode: 'number' }).notNull(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('PENDING'),
    idempotencyKey: uuid('idempotency_key').notNull(),
    reason: text('reason').notNull(),
    requestedAt: millis('requested_at'),
    completedAt: bigint('completed_at', { mode: 'number' }),
    result: jsonb('result'),
    correlationId: uuid('correlation_id').notNull(),
  },
  (t) => [
    uniqueIndex('command_idempotency').on(t.botId, t.idempotencyKey),
    foreignKey({
      columns: [t.botId, t.accountId],
      foreignColumns: [bots.id, bots.accountId],
    }),
    check('command_kind', sql`${t.kind} IN ('START','PAUSE','RESUME','STOP')`),
    check(
      'command_status',
      sql`${t.status} IN ('PENDING','APPLIED','REJECTED')`,
    ),
  ],
);
export const tradeLifecycles = pgTable(
  'trade_lifecycles',
  {
    id: uuid('id').primaryKey(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => evaluations.id),
    state: text('state').notNull(),
    side: text('side').notNull(),
    orderType: text('order_type').notNull(),
    executionBackend: text('execution_backend')
      .notNull()
      .default('FAKE_CONTRACT'),
    requestedQuantity: amount('requested_quantity'),
    filledQuantity: amount('filled_quantity'),
    closedQuantity: amount('closed_quantity'),
    entryReference: amount('entry_reference'),
    averageEntry: numeric('average_entry', { precision: 38, scale: 18 }),
    initialStop: amount('initial_stop'),
    desiredStop: amount('desired_stop'),
    submittedStop: numeric('submitted_stop', { precision: 38, scale: 18 }),
    confirmedStop: numeric('confirmed_stop', { precision: 38, scale: 18 }),
    takeProfit: amount('take_profit'),
    protectedQuantity: amount('protected_quantity'),
    protectionRevision: integer('protection_revision').notNull(),
    confirmedRevision: integer('confirmed_revision').notNull(),
    protectionStatus: text('protection_status').notNull(),
    entryTerminal: boolean('entry_terminal').notNull(),
    expiresAt: millis('expires_at'),
    openedAt: bigint('opened_at', { mode: 'number' }),
    createdAt: millis('created_at'),
    closedAt: bigint('closed_at', { mode: 'number' }),
    closeReason: text('close_reason'),
    closeGeneration: integer('close_generation').notNull(),
    pendingCancelReason: text('pending_cancel_reason'),
    trailingDistance: numeric('trailing_distance', {
      precision: 38,
      scale: 18,
    }),
    policy: jsonb('policy').notNull(),
  },
  (t) => [
    uniqueIndex('one_trade_per_evaluation').on(t.evaluationId),
    uniqueIndex('one_unresolved_lifecycle')
      .on(t.botId)
      .where(
        sql`${t.state} IN ('PENDING_ENTRY','OPEN','CLOSING','UNRESOLVED')`,
      ),
    foreignKey({
      columns: [t.botId, t.accountId],
      foreignColumns: [bots.id, bots.accountId],
    }),
    check('trade_backend', sql`${t.executionBackend}='FAKE_CONTRACT'`),
    check(
      'trade_state',
      sql`${t.state} IN ('PENDING_ENTRY','OPEN','CLOSING','UNRESOLVED','CLOSED','CANCELLED','EXPIRED')`,
    ),
    check('trade_side', sql`${t.side} IN ('LONG','SHORT')`),
    check('trade_order_type', sql`${t.orderType} IN ('MARKET','LIMIT')`),
    check(
      'trade_quantities',
      sql`${t.requestedQuantity}>0 AND ${t.filledQuantity}>=0 AND ${t.filledQuantity}<=${t.requestedQuantity} AND ${t.closedQuantity}>=0 AND ${t.closedQuantity}<=${t.filledQuantity} AND ${t.protectedQuantity}>=0 AND ${t.protectedQuantity}<=${t.filledQuantity}-${t.closedQuantity}`,
    ),
    check(
      'trade_prices',
      sql`${t.entryReference}>0 AND ${t.initialStop}>0 AND ${t.desiredStop}>0 AND ${t.takeProfit}>0 AND (${t.averageEntry} IS NULL OR ${t.averageEntry}>0) AND (${t.confirmedStop} IS NULL OR ${t.confirmedStop}>0)`,
    ),
    check(
      'protection_status',
      sql`${t.protectionStatus} IN ('UNCONFIRMED','REQUESTED','CONFIRMED','UNKNOWN')`,
    ),
  ],
);
export const runtimeActions = pgTable(
  'runtime_actions',
  {
    id: uuid('id').primaryKey(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id),
    tradeId: uuid('trade_id')
      .notNull()
      .references(() => tradeLifecycles.id),
    key: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    quantity: amount('quantity'),
    price: numeric('price', { precision: 38, scale: 18 }),
    stopPrice: numeric('stop_price', { precision: 38, scale: 18 }),
    takeProfit: numeric('take_profit', { precision: 38, scale: 18 }),
    revision: integer('revision').notNull(),
    reason: text('reason').notNull(),
    createdAt: millis('created_at'),
  },
  (t) => [
    uniqueIndex('runtime_action_idempotency').on(t.botId, t.key),
    check(
      'runtime_action_kind',
      sql`${t.kind} IN ('ENTRY','CANCEL_ENTRY','CLOSE','PROTECT','AMEND_STOP')`,
    ),
    check(
      'runtime_action_state',
      sql`${t.state} IN ('CREATED','SUBMITTING','OPEN','CONFIRMED','FILLED','CANCELLED','REJECTED','UNKNOWN')`,
    ),
    check('runtime_action_qty', sql`${t.quantity}>=0`),
  ],
);
export const runtimeCheckpoints = pgTable(
  'runtime_checkpoints',
  {
    botId: uuid('bot_id')
      .primaryKey()
      .references(() => bots.id),
    desired: text('desired').notNull(),
    lastPriceTime: millis('last_price_time'),
    lastCandleTime: millis('last_candle_time'),
    lastEvaluationId: uuid('last_evaluation_id').references(
      () => evaluations.id,
    ),
    fault: text('fault'),
    updatedAt: millis('updated_at'),
  },
  (t) => [
    check(
      'runtime_desired',
      sql`${t.desired} IN ('RUNNING','PAUSED','STOPPED')`,
    ),
  ],
);
export const runtimeEvents = pgTable(
  'runtime_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id),
    key: text('event_key').notNull(),
    kind: text('kind').notNull(),
    eventTime: millis('event_time'),
    fencingToken: bigint('fencing_token', { mode: 'number' }).notNull(),
    details: jsonb('details').notNull(),
  },
  (t) => [uniqueIndex('runtime_event_idempotency').on(t.botId, t.key)],
);
export const fakeReports = pgTable('fake_execution_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  sequence: bigserial('sequence', { mode: 'number' }).notNull(),
  botId: uuid('bot_id')
    .notNull()
    .references(() => bots.id),
  actionId: uuid('action_id')
    .notNull()
    .references(() => runtimeActions.id),
  eventKey: text('event_key').notNull().unique(),
  payload: jsonb('payload').notNull(),
});
