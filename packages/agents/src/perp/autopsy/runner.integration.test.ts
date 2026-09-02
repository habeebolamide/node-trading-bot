import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, llmCallLog, prediction, predictionOutcome, scoringConfig,
  signal, signalFeature, tradeAutopsy, tradingAgent, type Db,
} from '@tip/database';
import { ValidationError } from '@tip/domain';
import type { DeepSeekClient } from '@tip/llm';
import { createTradingAgent } from '@tip/trading-agents';
import { autopsyOne } from './runner.js';
import { AUTOPSY_VERSION_CURRENT } from './prompts.js';
import { AutopsyOutput } from './schema.js';
import { z } from 'zod';

const DATABASE_URL = process.env.DATABASE_URL;
const CFG = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

function successLLM(value: z.infer<typeof AutopsyOutput>): DeepSeekClient {
  return {
    async complete() {
      return { ok: true as const, value: value as never, usage: { promptTokens: 100, completionTokens: 50 }, latencyMs: 5, model: 'deepseek-v4-flash' };
    },
  };
}
function failingLLM(): DeepSeekClient {
  return {
    async complete() {
      return { ok: false as const, errorKind: 'HTTP_5XX' as const, message: 't', usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: 3, model: 'deepseek-v4-flash' };
    },
  };
}

describe.skipIf(!DATABASE_URL)('autopsy runner (integration)', () => {
  let db: Db;
  let agentId: string;
  const created = { agents: [] as string[], signals: [] as string[], predictions: [] as string[] };

  async function seedResolved(won: boolean): Promise<string> {
    const sid = randomUUID(); created.signals.push(sid);
    await db.insert(signal).values({
      id: sid, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp', direction: won ? 'LONG' : 'SHORT',
      compositeScore: '0.6', confidence: '0.7', state: 'CONSUMED',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), configVersion: 1,
      fingerprint: `ap-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    await db.insert(signalFeature).values({
      signalId: sid, agentKey: 'perp.momentum', agentVersion: 1, score: '0.7', confidence: '0.8', features: {},
    });
    const predId = randomUUID(); created.predictions.push(predId);
    await db.insert(prediction).values({
      id: predId, tradingAgentId: agentId, signalId: sid, domain: 'perp', symbol: 'BTCUSDT',
      direction: won ? 'LONG' : 'SHORT', score: '0.6', confidence: '0.7', horizon: '4h',
      entry: '100', stopLoss: won ? '98' : '102', takeProfit: won ? '104' : '96',
      positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20',
      riskReward: '2', features: [], configVersion: 1,
    });
    await db.insert(predictionOutcome).values({
      predictionId: predId, horizon: '4h',
      resolvedAt: new Date(), returnPct: won ? '0.04' : '-0.02', mfe: '0', mae: '0',
      hitTarget: won, hitInvalidation: !won, holdingPeriodSec: 3600, won, outcomeResolution: 'TICK',
    });
    return predId;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `AP-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: CFG,
    });
    agentId = a.id; created.agents.push(agentId);
  });

  afterAll(async () => {
    if (db) {
      if (created.predictions.length) {
        await db.delete(tradeAutopsy).where(inArray(tradeAutopsy.predictionId, created.predictions));
        await db.delete(llmCallLog).where(inArray(llmCallLog.predictionId, created.predictions));
        await db.delete(predictionOutcome).where(inArray(predictionOutcome.predictionId, created.predictions));
        await db.execute(sql`DROP TRIGGER IF EXISTS prediction_no_delete ON prediction`);
        await db.delete(prediction).where(inArray(prediction.id, created.predictions));
        await db.execute(sql`CREATE TRIGGER prediction_no_delete BEFORE DELETE ON prediction FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation()`);
      }
      if (created.signals.length) {
        await db.delete(signalFeature).where(inArray(signalFeature.signalId, created.signals));
        await db.delete(signal).where(inArray(signal.id, created.signals));
      }
      for (const id of created.agents) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('memecoin refused with §24 citation — silent skip would hide the mismatch', async () => {
    const predId = await seedResolved(true);
    await expect(autopsyOne({ db, llm: successLLM({ rootCause: 'x', successFactor: 'Y', explanation: 'z', contributingFactors: [], agentFailures: [], lesson: 'l', recommendation: 'r' }) },
      { predictionId: predId, domain: 'memecoin', planningHorizon: '4h' })).rejects.toThrow(ValidationError);
  });

  it('SUCCESS WIN: writes trade_autopsy with successFactor + llm_call_log link', async () => {
    const predId = await seedResolved(true);
    const r = await autopsyOne(
      { db, llm: successLLM({ rootCause: 'momentum lead', successFactor: 'MOMENTUM_CONFIRMED_EARLY', explanation: 'e', contributingFactors: [], agentFailures: [], lesson: 'l', recommendation: 'r' }) },
      { predictionId: predId, domain: 'perp', planningHorizon: '4h' },
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe('SUCCESS');
    expect(r!.outcome).toBe('WIN');
    const row = (await db.select().from(tradeAutopsy).where(eq(tradeAutopsy.predictionId, predId)))[0]!;
    expect(row.status).toBe('SUCCESS');
    expect(row.successFactor).toBe('MOMENTUM_CONFIRMED_EARLY');
    expect(row.failureCategory).toBeNull();
    expect(row.autopsyVersion).toBe(AUTOPSY_VERSION_CURRENT);
    const logs = await db.select().from(llmCallLog).where(eq(llmCallLog.predictionId, predId));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.agent).toBe('autopsy');
    expect(logs[0]!.success).toBe(true);
  });

  it('SUCCESS LOSS: writes trade_autopsy with failureCategory populated', async () => {
    const predId = await seedResolved(false);
    const r = await autopsyOne(
      { db, llm: successLLM({ rootCause: 'positioning misread', failureCategory: 'POSITIONING_MISREAD', explanation: 'e', contributingFactors: [], agentFailures: [], lesson: 'l', recommendation: 'r' }) },
      { predictionId: predId, domain: 'perp', planningHorizon: '4h' },
    );
    expect(r!.outcome).toBe('LOSS');
    const row = (await db.select().from(tradeAutopsy).where(eq(tradeAutopsy.predictionId, predId)))[0]!;
    expect(row.failureCategory).toBe('POSITIONING_MISREAD');
    expect(row.successFactor).toBeNull();
  });

  it('WIN/LOSS invariant violation → downgrades to FAILED_LLM (not a bad row)', async () => {
    const predId = await seedResolved(true); // outcome is WIN
    const r = await autopsyOne(
      { db, llm: successLLM({ rootCause: 'x', failureCategory: 'WRONG_FIELD', explanation: 'e', contributingFactors: [], agentFailures: [], lesson: 'l', recommendation: 'r' }) },
      { predictionId: predId, domain: 'perp', planningHorizon: '4h' },
    );
    expect(r!.status).toBe('FAILED_LLM');
    const row = (await db.select().from(tradeAutopsy).where(eq(tradeAutopsy.predictionId, predId)))[0]!;
    expect(row.status).toBe('FAILED_LLM');
    expect(row.failureCategory).toBeNull();
    expect(row.successFactor).toBeNull();
  });

  it('LLM failure: writes FAILED_LLM row (retryable via UPDATE-in-place)', async () => {
    const predId = await seedResolved(true);
    const r1 = await autopsyOne({ db, llm: failingLLM() },
      { predictionId: predId, domain: 'perp', planningHorizon: '4h' });
    expect(r1!.status).toBe('FAILED_LLM');
    const row1 = (await db.select().from(tradeAutopsy).where(eq(tradeAutopsy.predictionId, predId)))[0]!;
    expect(row1.status).toBe('FAILED_LLM');
    const originalId = row1.id;

    // Retry with a successful LLM — same row updates in place (unique(prediction_id) drives conflict).
    const r2 = await autopsyOne(
      { db, llm: successLLM({ rootCause: 'r', successFactor: 'S', explanation: 'e', contributingFactors: [], agentFailures: [], lesson: 'l', recommendation: 'r' }) },
      { predictionId: predId, domain: 'perp', planningHorizon: '4h' },
    );
    expect(r2!.status).toBe('SUCCESS');
    const row2 = (await db.select().from(tradeAutopsy).where(eq(tradeAutopsy.predictionId, predId)))[0]!;
    expect(row2.id).toBe(originalId); // same row
    expect(row2.status).toBe('SUCCESS');
    expect(row2.successFactor).toBe('S');
  });

  it('idempotency: replaying the same event does not create a second row', async () => {
    const predId = await seedResolved(false);
    const evt = { predictionId: predId, domain: 'perp' as const, planningHorizon: '4h' };
    const llm = successLLM({ rootCause: 'r', failureCategory: 'REGIME_SHIFTED_MID_TRADE', explanation: 'e', contributingFactors: [], agentFailures: [], lesson: 'l', recommendation: 'r' });
    await autopsyOne({ db, llm }, evt);
    await autopsyOne({ db, llm }, evt);
    const rows = await db.select().from(tradeAutopsy).where(eq(tradeAutopsy.predictionId, predId));
    expect(rows).toHaveLength(1);
  });
});
