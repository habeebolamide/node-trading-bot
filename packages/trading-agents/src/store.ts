/**
 * TradingAgent CRUD (§14/§16). `updateConfig` writes a NEW ScoringConfig version and flips
 * the agent's `activeConfigVersion` — atomically in one transaction. The prior row stays
 * (only `active` may become false); rows are never mutated (§33 rule 16). Every downstream
 * Prediction/Signal FKs the specific version that produced it (§19).
 */
import { randomUUID } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { ValidationError } from '@tip/domain';
import { tradingAgent, scoringConfig, type Db } from '@tip/database';
import { validateScoringConfig, type ScoringConfig } from './config.js';
import type { Domain, TradingStyle, TradingAgentIdentity } from './identity.js';
import { DOMAINS, TRADING_STYLES } from './identity.js';

export interface CreateTradingAgentInput {
  name: string;
  domain: Domain;
  universe: string[];
  tradingStyle: TradingStyle;
  config: unknown; // validated per domain via validateScoringConfig
}

export interface TradingAgentRow extends TradingAgentIdentity {
  activeConfigVersion: number;
  status: string;
  createdAt: Date;
  config: ScoringConfig;
}

const OK_STATUSES = ['active', 'blocked', 'archived'] as const;

/** Validate + persist a new TradingAgent + its v1 ScoringConfig in one txn. */
export async function createTradingAgent(db: Db, input: CreateTradingAgentInput): Promise<TradingAgentRow> {
  if (!input.name || input.name.trim() === '') throw new ValidationError('name is required');
  if (!DOMAINS.includes(input.domain)) throw new ValidationError(`invalid domain: ${input.domain}`);
  if (!TRADING_STYLES.includes(input.tradingStyle)) throw new ValidationError(`invalid tradingStyle: ${input.tradingStyle}`);
  if (!Array.isArray(input.universe) || input.universe.length === 0) throw new ValidationError('universe must be a non-empty array');

  const cfg = validateScoringConfig(input.config, input.domain);
  const agentId = randomUUID();
  const configId = randomUUID();

  return db.transaction(async (tx) => {
    await tx.insert(tradingAgent).values({
      id: agentId,
      name: input.name,
      domain: input.domain,
      universe: input.universe,
      tradingStyle: input.tradingStyle,
      activeConfigVersion: 1,
    });
    await tx.insert(scoringConfig).values({
      id: configId,
      tradingAgentId: agentId,
      version: 1,
      config: cfg,
      active: true,
    });
    return (await getTradingAgent(tx as unknown as Db, agentId))!;
  });
}

/** Get a TradingAgent + its active config, or null if not found. */
export async function getTradingAgent(db: Db, id: string): Promise<TradingAgentRow | null> {
  const rows = await db.select().from(tradingAgent).where(eq(tradingAgent.id, id)).limit(1);
  const agent = rows[0];
  if (!agent) return null;
  const cfgRow = (
    await db
      .select({ config: scoringConfig.config })
      .from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, id), eq(scoringConfig.version, agent.activeConfigVersion)))
      .limit(1)
  )[0];
  if (!cfgRow) return null;
  return toRow(agent, cfgRow.config as ScoringConfig);
}

/** List all trading agents (with optional status filter). */
export async function listTradingAgents(db: Db, opts: { status?: string } = {}): Promise<TradingAgentRow[]> {
  const agents = opts.status
    ? await db.select().from(tradingAgent).where(eq(tradingAgent.status, opts.status))
    : await db.select().from(tradingAgent);
  const out: TradingAgentRow[] = [];
  for (const a of agents) {
    const row = await getTradingAgent(db, a.id);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Write a new ScoringConfig version and flip the agent's activeConfigVersion. The prior row
 * stays as history (only `active` flips false). One transaction — atomic.
 */
export async function updateTradingAgentConfig(db: Db, id: string, config: unknown): Promise<TradingAgentRow> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(tradingAgent).where(eq(tradingAgent.id, id)).limit(1);
    const agent = rows[0];
    if (!agent) throw new ValidationError(`TradingAgent ${id} not found`);
    const cfg = validateScoringConfig(config, agent.domain as Domain);

    const latest = (
      await tx
        .select({ version: scoringConfig.version })
        .from(scoringConfig)
        .where(eq(scoringConfig.tradingAgentId, id))
        .orderBy(desc(scoringConfig.version))
        .limit(1)
    )[0];
    const nextVersion = (latest?.version ?? 0) + 1;

    await tx
      .update(scoringConfig)
      .set({ active: false })
      .where(and(eq(scoringConfig.tradingAgentId, id), eq(scoringConfig.active, true)));
    await tx.insert(scoringConfig).values({
      id: randomUUID(),
      tradingAgentId: id,
      version: nextVersion,
      config: cfg,
      active: true,
    });
    await tx.update(tradingAgent).set({ activeConfigVersion: nextVersion }).where(eq(tradingAgent.id, id));

    return toRow({ ...agent, activeConfigVersion: nextVersion }, cfg);
  });
}

/** Set the agent's status (active | blocked | archived). */
export async function setTradingAgentStatus(db: Db, id: string, status: string): Promise<void> {
  if (!OK_STATUSES.includes(status as (typeof OK_STATUSES)[number])) {
    throw new ValidationError(`invalid status: ${status}`);
  }
  await db.update(tradingAgent).set({ status }).where(eq(tradingAgent.id, id));
}

function toRow(agent: typeof tradingAgent.$inferSelect, cfg: ScoringConfig): TradingAgentRow {
  return {
    id: agent.id,
    name: agent.name,
    domain: agent.domain as Domain,
    universe: agent.universe,
    tradingStyle: agent.tradingStyle as TradingStyle,
    activeConfigVersion: agent.activeConfigVersion,
    status: agent.status,
    createdAt: agent.createdAt,
    config: cfg,
  };
}
