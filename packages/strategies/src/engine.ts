import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type {
  StrategyDefinition,
  EvaluationInput,
  EvaluationRecord,
  EvaluationRepository,
  EvaluationSnapshot,
  EntryDecision,
} from './contracts.js';
import { buildContext, triggerKey } from './context.js';
import { freeze } from './helpers.js';
import { decimalString, epoch } from '../../market-data/src/contracts.js';
const reason = z.enum([
  'NO_SETUP',
  'WEAK_TREND',
  'CONFLICTING_SIGNALS',
  'MARKET_REGIME_UNSUITABLE',
  'VOLATILITY_UNSUITABLE',
  'INSUFFICIENT_DATA',
  'DATA_GAP',
  'STALE_DATA',
  'INVALID_DATA',
  'MARKET_DATA_UNHEALTHY',
  'TREND_CONFIRMED',
  'MEAN_REVERSION_EXTREME',
]);
const decisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('NO_TRADE'), reason }).strict(),
  z
    .object({
      action: z.literal('PROPOSE_ENTRY'),
      side: z.enum(['LONG', 'SHORT']),
      orderType: z.enum(['MARKET', 'LIMIT']),
      entryPrice: decimalString,
      stopLoss: decimalString,
      takeProfit: decimalString,
      expiresAt: epoch,
      reason,
    })
    .strict(),
]);
export function preview(
  definition: StrategyDefinition,
  input: EvaluationInput,
): { key: string; snapshot: EvaluationSnapshot } {
  if (input.tradingState !== 'IDLE')
    throw Error('ENTRY_BLOCKED: bot has an unresolved lifecycle');
  z.uuid().parse(input.botId);
  z.uuid().parse(input.accountId);
  z.uuid().parse(input.strategyVersionId);
  z.number().int().positive().parse(input.configVersion);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.codeHash);
  const key = triggerKey(definition, input.market, input.trigger),
    context = buildContext(definition, input);
  const decision: EntryDecision = context.dataQuality.ready
    ? decisionSchema.parse(definition.evaluateEntry(context))
    : {
        action: 'NO_TRADE',
        reason: context.dataQuality.reason ?? 'INSUFFICIENT_DATA',
      };
  if (decision.action === 'PROPOSE_ENTRY') {
    const e = new Decimal(decision.entryPrice),
      s = new Decimal(decision.stopLoss),
      t = new Decimal(decision.takeProfit);
    if (
      e.lte(0) ||
      s.lte(0) ||
      t.lte(0) ||
      decision.expiresAt <= context.marketCutoff ||
      (decision.side === 'LONG' ? s.gte(e) || t.lte(e) : s.lte(e) || t.gte(e))
    )
      throw Error('INVALID_DECISION: inconsistent entry levels');
  }
  return {
    key,
    snapshot: freeze({
      schemaVersion: 1,
      strategy: {
        id: definition.id,
        version: definition.version,
        preset: definition.preset,
        codeHash: input.codeHash,
        parameters: structuredClone(definition.parameters),
        requirements: structuredClone(definition.requirements),
        managementPolicy: structuredClone(definition.managementPolicy),
      },
      configVersion: input.configVersion,
      context,
      decision,
    }),
  };
}
export class StrategyEngine {
  constructor(private repository: EvaluationRepository) {}
  async evaluate(
    definition: StrategyDefinition,
    input: EvaluationInput,
    correlationId: string,
  ): Promise<EvaluationRecord> {
    if (input.tradingState !== 'IDLE')
      throw Error('ENTRY_BLOCKED: bot has an unresolved lifecycle');
    z.uuid().parse(correlationId);
    const key = triggerKey(definition, input.market, input.trigger);
    const previous = await this.repository.find(
      input.botId,
      input.strategyVersionId,
      input.trigger.type,
      key,
    );
    if (previous) {
      if (previous.accountId !== input.accountId)
        throw Error('Evaluation account mismatch');
      return freeze(previous) as EvaluationRecord;
    }
    const { snapshot } = preview(definition, input);
    const stored = await this.repository.insert({
      botId: input.botId,
      accountId: input.accountId,
      strategyVersionId: input.strategyVersionId,
      configVersion: input.configVersion,
      triggerType: input.trigger.type,
      triggerEventKey: key,
      decision:
        snapshot.decision.action === 'NO_TRADE'
          ? 'NO_TRADE'
          : snapshot.decision.side,
      reasonCode: snapshot.decision.reason,
      eventTime: input.trigger.eventTime,
      decisionTime: input.trigger.observedAt,
      snapshot,
      correlationId,
    });
    return freeze(stored) as EvaluationRecord;
  }
}
