import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, paperPortfolio, paperPosition, prediction, scoringConfig, signal, tradingAgent, type Db,
} from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import { evaluateDailyLoss } from './daily-loss.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-06-01T18:00:00Z');
const cfg = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
  dailyLossLimit: 0.05,
};

describe.skipIf(!DATABASE_URL)('evaluateDailyLoss (integration)', () => {
  let db: Db;
  let agentId: string;
  let portfolioId: string;
  const created = { agents: [] as string[], portfolios: [] as string[], positions: [] as string[], signals: [] as string[], predictions: [] as string[] };

  async function closedPosition(pnl: number, closedAt: Date): Promise<void> {
    const sigId = randomUUID(); created.signals.push(sigId);
    await db.insert(signal).values({ id: sigId, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state: 'CONSUMED', createdAt: NOW, expiresAt: new Date(NOW.getTime()+60000),
      configVersion: 1, fingerprint: `dl-${randomUUID().slice(0,8)}`, evidence: {} });
    const predId = randomUUID(); created.predictions.push(predId);
    await db.insert(prediction).values({ id: predId, tradingAgentId: agentId, signalId: sigId, domain: 'perp', symbol: 'BTCUSDT',
      direction: 'LONG', score: '0.6', confidence: '0.7', horizon: '4h', entry: '100', stopLoss: '98', takeProfit: '104',
      positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20', riskReward: '2', features: [], configVersion: 1, createdAt: NOW });
    const posId = randomUUID(); created.positions.push(posId);
    await db.insert(paperPosition).values({ id: posId, portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp',
      direction: 'LONG', state: 'CLOSED', entryPrice: '100', size: '1', remainingSize: '0', currentStop: '98', takeProfit: '104',
      realizedPnl: String(pnl), closedAt, openedAtEvent: NOW, openedAtProcessing: NOW, isShadow: false });
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, { name: `DL-${randomUUID().slice(0,6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: cfg });
    agentId = a.id; created.agents.push(agentId);
    const p = await db.insert(paperPortfolio).values({ id: randomUUID(), tradingAgentId: agentId, startingCash: '10000', cash: '10000', equity: '10000', peakEquity: '10000' }).returning();
    portfolioId = p[0]!.id; created.portfolios.push(portfolioId);
  });
  afterAll(async () => {
    if (db) {
      if (created.positions.length) await db.delete(paperPosition).where(inArray(paperPosition.id, created.positions));
      if (created.portfolios.length) await db.delete(paperPortfolio).where(inArray(paperPortfolio.id, created.portfolios));
      if (created.predictions.length) {
        await db.execute(sql`DROP TRIGGER IF EXISTS prediction_no_delete ON prediction`);
        await db.delete(prediction).where(inArray(prediction.id, created.predictions));
        await db.execute(sql`CREATE TRIGGER prediction_no_delete BEFORE DELETE ON prediction FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation()`);
      }
      if (created.signals.length) await db.delete(signal).where(inArray(signal.id, created.signals));
      for (const id of created.agents) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('does not trip below the limit', async () => {
    await closedPosition(-200, new Date('2026-06-01T10:00:00Z')); // -2% of 10k
    const r = await evaluateDailyLoss(db, { tradingAgentId: agentId, dailyLossLimit: 0.05, now: NOW });
    expect(r.tripped).toBe(false);
    expect(r.realizedTodayPct).toBeCloseTo(-0.02, 6);
  });

  it('trips when the cumulative day loss crosses the limit', async () => {
    await closedPosition(-400, new Date('2026-06-01T12:00:00Z')); // now -6% total
    const r = await evaluateDailyLoss(db, { tradingAgentId: agentId, dailyLossLimit: 0.05, now: NOW });
    expect(r.tripped).toBe(true);
    expect(r.realizedTodayPct).toBeCloseTo(-0.06, 6);
    expect(r.blockUntil!.toISOString()).toBe('2026-06-02T00:00:00.000Z'); // next UTC day
  });

  it('yesterday losses do not count toward today', async () => {
    // A fresh agent whose only loss was yesterday.
    const a2 = await createTradingAgent(db, { name: `DL2-${randomUUID().slice(0,6)}`, domain: 'perp', universe: ['ETHUSDT'], tradingStyle: 'day', config: cfg });
    created.agents.push(a2.id);
    const p2 = await db.insert(paperPortfolio).values({ id: randomUUID(), tradingAgentId: a2.id, startingCash: '10000', cash: '10000', equity: '10000', peakEquity: '10000' }).returning();
    created.portfolios.push(p2[0]!.id);
    const oldAgent = agentId, oldPort = portfolioId;
    agentId = a2.id; portfolioId = p2[0]!.id;
    await closedPosition(-900, new Date('2026-05-31T12:00:00Z')); // yesterday, -9%
    const r = await evaluateDailyLoss(db, { tradingAgentId: a2.id, dailyLossLimit: 0.05, now: NOW });
    expect(r.tripped).toBe(false); // yesterday's loss is excluded
    agentId = oldAgent; portfolioId = oldPort;
  });

  it('no limit configured → never trips', async () => {
    const r = await evaluateDailyLoss(db, { tradingAgentId: agentId, now: NOW });
    expect(r.tripped).toBe(false);
    expect(r.limitPct).toBeNull();
  });
});
