import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, paperPortfolio, paperPosition, prediction, scoringConfig, signal, tradingAgent, type Db,
} from '@tip/database';
import type { EventBus } from '@tip/events';
import { createTradingAgent } from '@tip/trading-agents';
import { openPosition, openPendingPosition } from '@tip/paper-engine';
import { processTick } from './tick-monitor.js';

const DATABASE_URL = process.env.DATABASE_URL;
const T = new Date('2026-06-01T00:00:00Z');
const cfg = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('tick monitor (integration)', () => {
  let db: Db;
  let agentId: string;
  let portfolioId: string;
  const bus = { publish: vi.fn(async () => ({ id: 'e' })) } as unknown as EventBus;
  const created = { agents: [] as string[], portfolios: [] as string[], positions: [] as string[], signals: [] as string[], predictions: [] as string[] };
  const deps = () => ({ db, bus });
  const styleFor = async () => 'day' as const;

  async function makePrediction(entry: number, stop: number, tp: number | null): Promise<string> {
    const sigId = randomUUID(); created.signals.push(sigId);
    await db.insert(signal).values({ id: sigId, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state: 'CONSUMED', createdAt: T, expiresAt: new Date(T.getTime()+60000),
      configVersion: 1, fingerprint: `tm-${randomUUID().slice(0,8)}`, evidence: {} });
    const predId = randomUUID(); created.predictions.push(predId);
    await db.insert(prediction).values({ id: predId, tradingAgentId: agentId, signalId: sigId, domain: 'perp', symbol: 'BTCUSDT',
      direction: 'LONG', score: '0.6', confidence: '0.7', horizon: '4h', entry: String(entry), stopLoss: String(stop),
      takeProfit: tp === null ? null : String(tp), positionSize: '1', notional: String(entry), leverage: '5',
      requiredMargin: '20', riskReward: '2', features: [], configVersion: 1, createdAt: T });
    return predId;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, { name: `TM-${randomUUID().slice(0,6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: cfg });
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

  it('closes an OPEN position on a STOP crossing + moves agent to COOLDOWN', async () => {
    const predId = await makePrediction(100, 98, 104);
    const pos = await openPosition(db, { portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 100, size: 1, currentStop: 98, takeProfit: 104, ladder: null, openedAtEvent: T, openedAtProcessing: T });
    created.positions.push(pos.id);
    // A bar whose LOW dips to 97 → crosses the stop at 98.
    await processTick(deps(), { symbol: 'BTCUSDT', high: 101, low: 97, close: 99, now: new Date(T.getTime()+3600_000), style: styleFor });
    const after = (await db.select().from(paperPosition).where(eq(paperPosition.id, pos.id)).limit(1))[0]!;
    expect(after.state).toBe('CLOSED');
    expect(after.closeReason).toBe('STOP_LOSS');
    const agent = (await db.select().from(tradingAgent).where(eq(tradingAgent.id, agentId)).limit(1))[0]!;
    expect(agent.lifecycleState).toBe('COOLDOWN');
  });

  it('closes an OPEN position on a TP crossing', async () => {
    const predId = await makePrediction(100, 90, 105);
    const pos = await openPosition(db, { portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 100, size: 1, currentStop: 90, takeProfit: 105, ladder: null, openedAtEvent: T, openedAtProcessing: T });
    created.positions.push(pos.id);
    // High reaches 106 → TP at 105 crossed. Stop (90) not touched.
    await processTick(deps(), { symbol: 'BTCUSDT', high: 106, low: 99, close: 105, now: new Date(T.getTime()+3600_000), style: styleFor });
    const after = (await db.select().from(paperPosition).where(eq(paperPosition.id, pos.id)).limit(1))[0]!;
    expect(after.state).toBe('CLOSED');
    expect(after.closeReason).toBe('TAKE_PROFIT');
  });

  it('activates a PENDING_ENTRY LIMIT when the price crosses the limit', async () => {
    const predId = await makePrediction(98, 95, 107); // limit at 98
    const pos = await openPendingPosition(db, { portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 98, size: 1, currentStop: 95, takeProfit: 107, ladder: null, openedAtEvent: T, openedAtProcessing: T });
    created.positions.push(pos.id);
    // Low dips to 97.5 → LONG limit at 98 fills.
    await processTick(deps(), { symbol: 'BTCUSDT', high: 100, low: 97.5, close: 99, now: new Date(T.getTime()+3600_000), style: styleFor });
    const after = (await db.select().from(paperPosition).where(eq(paperPosition.id, pos.id)).limit(1))[0]!;
    expect(after.state).toBe('OPEN');
  });

  it('expires a PENDING_ENTRY LIMIT past its window (day = 6h)', async () => {
    const predId = await makePrediction(90, 85, 100); // limit at 90, far below
    const pos = await openPendingPosition(db, { portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 90, size: 1, currentStop: 85, takeProfit: 100, ladder: null, openedAtEvent: T, openedAtProcessing: T });
    created.positions.push(pos.id);
    // 7h later, price never reached 90 → expire.
    await processTick(deps(), { symbol: 'BTCUSDT', high: 101, low: 99, close: 100, now: new Date(T.getTime()+7*3600_000), style: styleFor });
    const after = (await db.select().from(paperPosition).where(eq(paperPosition.id, pos.id)).limit(1))[0]!;
    expect(after.state).toBe('EXPIRED');
    expect(after.closeReason).toBe('LIMIT_EXPIRY');
  });

  it('leaves an OPEN position alone when neither stop nor TP is touched', async () => {
    const predId = await makePrediction(100, 90, 110);
    const pos = await openPosition(db, { portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 100, size: 1, currentStop: 90, takeProfit: 110, ladder: null, openedAtEvent: T, openedAtProcessing: T });
    created.positions.push(pos.id);
    await processTick(deps(), { symbol: 'BTCUSDT', high: 102, low: 99, close: 101, now: new Date(T.getTime()+60_000), style: styleFor });
    const after = (await db.select().from(paperPosition).where(eq(paperPosition.id, pos.id)).limit(1))[0]!;
    expect(after.state).toBe('OPEN');
    // MFE should have updated to at least (102-100)/100.
    expect(Number(after.mfe)).toBeGreaterThan(0);
  });
});
