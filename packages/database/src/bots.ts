import { and, eq } from 'drizzle-orm';
import { DomainError, marketKey, type BotInput } from '../../core/src/index.js';
import {
  accounts,
  bots,
  configs,
  ownership,
  audits,
  strategyVersions,
  type Database,
} from './index.js';
export type Actor = { userId: string; role: 'OWNER' | 'VIEWER' };
export class BotRepository {
  constructor(private db: Database) {}
  async account(actor: Actor) {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.ownerUserId, actor.userId));
    if (!account)
      throw new DomainError(
        'ACCOUNT_NOT_FOUND',
        'No paper portfolio configured',
        404,
      );
    return account;
  }
  async list(actor: Actor) {
    const account = await this.account(actor);
    return this.db.select().from(bots).where(eq(bots.accountId, account.id));
  }
  async get(actor: Actor, id: string) {
    const account = await this.account(actor);
    const [bot] = await this.db
      .select()
      .from(bots)
      .where(and(eq(bots.id, id), eq(bots.accountId, account.id)));
    if (!bot) throw new DomainError('BOT_NOT_FOUND', 'Bot not found', 404);
    return bot;
  }
  async history(actor: Actor, id: string) {
    await this.get(actor, id);
    return this.db
      .select()
      .from(configs)
      .where(eq(configs.botId, id))
      .orderBy(configs.configVersion);
  }
  async create(actor: Actor, input: BotInput, correlationId: string) {
    const account = await this.account(actor);
    return this.db.transaction(async (tx) => {
      await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, account.id))
        .for('update');
      const [strategy] = await tx
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.id, input.strategyVersionId));
      if (!strategy)
        throw new DomainError(
          'STRATEGY_NOT_FOUND',
          'Strategy version not found',
          404,
        );
      const [bot] = await tx
        .insert(bots)
        .values({
          accountId: account.id,
          name: input.name,
          market: input.market,
          canonicalMarketId: marketKey(input.market),
          strategyVersionId: input.strategyVersionId,
          executionMode: input.executionMode,
          riskProfile: input.riskProfile,
          allocationTargetPercent: input.allocationTargetPercent,
        })
        .returning();
      if (!bot) throw new Error('Bot insert failed');
      await tx.insert(ownership).values({
        accountId: account.id,
        canonicalCoinKey: input.market.baseAsset,
        scope: account.replayScope,
        botId: bot.id,
      });
      await tx.insert(configs).values({
        botId: bot.id,
        configVersion: 1,
        config: bot,
        changedBy: actor.userId,
        reason: 'Bot created',
        correlationId,
      });
      await tx.insert(audits).values({
        accountId: account.id,
        botId: bot.id,
        actorId: actor.userId,
        eventType: 'bot.created',
        correlationId,
        details: { configVersion: 1 },
      });
      return bot;
    });
  }
  async update(
    actor: Actor,
    id: string,
    input: {
      name?: string;
      allocationTargetPercent?: string;
      expectedVersion: number;
      reason: string;
    },
    correlationId: string,
  ) {
    const account = await this.account(actor);
    return this.db.transaction(async (tx) => {
      await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, account.id))
        .for('update');
      const [existing] = await tx
        .select()
        .from(bots)
        .where(and(eq(bots.id, id), eq(bots.accountId, account.id)))
        .for('update');
      if (!existing)
        throw new DomainError('BOT_NOT_FOUND', 'Bot not found', 404);
      if (existing.version !== input.expectedVersion)
        throw new DomainError(
          'VERSION_CONFLICT',
          'Configuration changed; fetch current version',
          409,
        );
      if (
        existing.operationalStatus !== 'STOPPED' ||
        existing.tradingState !== 'IDLE'
      )
        throw new DomainError(
          'BOT_NOT_IDLE',
          'Configuration requires a stopped, idle bot',
          409,
        );
      const [bot] = await tx
        .update(bots)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.allocationTargetPercent !== undefined
            ? { allocationTargetPercent: input.allocationTargetPercent }
            : {}),
          configVersion: existing.configVersion + 1,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(bots.id, id))
        .returning();
      if (!bot) throw new Error('Bot update failed');
      await tx.insert(configs).values({
        botId: id,
        configVersion: bot.configVersion,
        config: bot,
        changedBy: actor.userId,
        reason: input.reason,
        correlationId,
      });
      await tx.insert(audits).values({
        accountId: account.id,
        botId: id,
        actorId: actor.userId,
        eventType: 'bot.config_updated',
        correlationId,
        details: { configVersion: bot.configVersion, reason: input.reason },
      });
      return bot;
    });
  }
}
