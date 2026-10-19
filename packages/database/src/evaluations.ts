import { and, eq } from 'drizzle-orm';
import {
  bots,
  configs,
  strategyVersions,
  evaluations,
  type Database,
} from './index.js';
import type {
  EvaluationRecord,
  EvaluationRepository,
} from '../../strategies/src/contracts.js';
export class PostgresEvaluationRepository implements EvaluationRepository {
  constructor(private db: Database) {}
  async find(
    botId: string,
    strategyVersionId: string,
    trigger: EvaluationRecord['triggerType'],
    key: string,
  ) {
    const [row] = await this.db
      .select()
      .from(evaluations)
      .where(
        and(
          eq(evaluations.botId, botId),
          eq(evaluations.strategyVersionId, strategyVersionId),
          eq(evaluations.triggerType, trigger),
          eq(evaluations.triggerEventKey, key),
        ),
      );
    return row ? this.record(row) : undefined;
  }
  private record(row: typeof evaluations.$inferSelect): EvaluationRecord {
    const { configSnapshotId, ...record } = row;
    return record as EvaluationRecord;
  }
  async insert(record: Omit<EvaluationRecord, 'id'>) {
    return this.db.transaction(async (tx) => {
      const [bot] = await tx
        .select()
        .from(bots)
        .where(
          and(eq(bots.id, record.botId), eq(bots.accountId, record.accountId)),
        )
        .for('share');
      if (
        !bot ||
        bot.configVersion !== record.configVersion ||
        bot.strategyVersionId !== record.strategyVersionId ||
        bot.tradingState !== 'IDLE'
      )
        throw Error(
          'Bot configuration or trading state changed before evaluation commit',
        );
      const [config] = await tx
        .select()
        .from(configs)
        .where(
          and(
            eq(configs.botId, bot.id),
            eq(configs.configVersion, record.configVersion),
          ),
        );
      const [strategy] = await tx
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.id, record.strategyVersionId));
      if (
        !config ||
        strategy?.codeHash !== record.snapshot.strategy.codeHash ||
        strategy?.version !== record.snapshot.strategy.version
      )
        throw Error(
          'Evaluation snapshot does not match registered code/configuration',
        );
      const [row] = await tx
        .insert(evaluations)
        .values({
          ...record,
          configSnapshotId: config.id,
          snapshot: record.snapshot,
        })
        .onConflictDoNothing()
        .returning();
      if (row) return this.record(row);
      const [existing] = await tx
        .select()
        .from(evaluations)
        .where(
          and(
            eq(evaluations.botId, record.botId),
            eq(evaluations.strategyVersionId, record.strategyVersionId),
            eq(evaluations.triggerType, record.triggerType),
            eq(evaluations.triggerEventKey, record.triggerEventKey),
          ),
        );
      if (!existing) throw Error('Evaluation conflict could not be reconciled');
      return this.record(existing);
    });
  }
}
