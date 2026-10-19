import {
  pgTable,
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
      'phase1_stopped',
      sql`${t.operationalStatus} = 'STOPPED' AND ${t.tradingState} = 'IDLE'`,
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
