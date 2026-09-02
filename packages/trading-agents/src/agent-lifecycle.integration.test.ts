import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, paperPortfolio, paperPosition, prediction, scoringConfig, signal, tradingAgent, type Db,
} from '@tip/database';
import { createTradingAgent } from './store.js';
import {
  blockAgent, deriveAgentState, enterCooldown, getAgentState, refreshAgentState,
  tickLifecycle, unblockAgent,
} from './agent-lifecycle.js';

const DATABASE_URL = process.env.DATABASE_URL;
const T = new Date('2026-06-01T00:00:00Z');
const cfg = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('agent lifecycle (integration)', () => {
  let db: Db;
  let agentId: string;
  const created = { agents: [] as string[], signals: [] as string[], predictions: [] as string[], positions: [] as string[], portfolios: [] as string[] };

  async function newAgent(): Promise<string> {
    const a = await createTradingAgent(db, { name: `LC-${randomUUID().slice(0,6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: cfg });
    created.agents.push(a.id);
    return a.id;
  }
  async function addSignal(aid: string, state = 'ACTIVE'): Promise<string> {
    const id = randomUUID(); created.signals.push(id);
    await db.insert(signal).values({ id, tradingAgentId: aid, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state, createdAt: T, expiresAt: new Date(T.getTime()+60000),
      configVersion: 1, fingerprint: `lc-${randomUUID().slice(0,8)}`, evidence: {} });
    return id;
  }
  async function addPosition(aid: string, sigId: string, state: 'OPEN' | 'PENDING_ENTRY'): Promise<void> {
    const port = await db.insert(paperPortfolio).values({ id: randomUUID(), tradingAgentId: aid, startingCash: '10000', cash: '10000', equity: '10000', peakEquity: '10000' }).returning();
    created.portfolios.push(port[0]!.id);
    const predId = randomUUID(); created.predictions.push(predId);
    await db.insert(prediction).values({ id: predId, tradingAgentId: aid, signalId: sigId, domain: 'perp', symbol: 'BTCUSDT',
      direction: 'LONG', score: '0.6', confidence: '0.7', horizon: '4h', entry: '100', stopLoss: '98', takeProfit: '104',
      positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20', riskReward: '2', features: [], configVersion: 1, createdAt: T });
    const posId = randomUUID(); created.positions.push(posId);
    await db.insert(paperPosition).values({ id: posId, portfolioId: port[0]!.id, predictionId: predId, symbol: 'BTCUSDT',
      domain: 'perp', direction: 'LONG', state, entryPrice: '100', size: '1', remainingSize: '1', currentStop: '98',
      takeProfit: '104', openedAtEvent: T, openedAtProcessing: T, isShadow: false });
  }

  beforeAll(() => { db = createDb(DATABASE_URL!); });
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

  it('new agent starts IDLE', async () => {
    const aid = await newAgent();
    expect((await getAgentState(db, aid))!.state).toBe('IDLE');
  });

  it('derives WATCHING with an ACTIVE signal, IDLE without', async () => {
    const aid = await newAgent();
    expect(await deriveAgentState(db, aid)).toBe('IDLE');
    await addSignal(aid, 'ACTIVE');
    expect(await deriveAgentState(db, aid)).toBe('WATCHING');
  });

  it('derives IN_TRADE with an OPEN position (dominates a WATCHING signal)', async () => {
    const aid = await newAgent();
    const sig = await addSignal(aid, 'ACTIVE');
    await addPosition(aid, sig, 'OPEN');
    expect(await deriveAgentState(db, aid)).toBe('IN_TRADE');
  });

  it('derives PENDING_ENTRY with a pending position and no open one', async () => {
    const aid = await newAgent();
    const sig = await addSignal(aid, 'CONSUMED');
    await addPosition(aid, sig, 'PENDING_ENTRY');
    expect(await deriveAgentState(db, aid)).toBe('PENDING_ENTRY');
  });

  it('refreshAgentState persists the derived state', async () => {
    const aid = await newAgent();
    await addSignal(aid, 'ACTIVE');
    const s = await refreshAgentState(db, aid);
    expect(s).toBe('WATCHING');
    expect((await getAgentState(db, aid))!.state).toBe('WATCHING');
  });

  it('COOLDOWN is sticky — refresh does not derive over it until it expires', async () => {
    const aid = await newAgent();
    await enterCooldown(db, aid, 60_000, T);
    expect((await getAgentState(db, aid))!.state).toBe('COOLDOWN');
    // refresh at a time BEFORE `until` keeps COOLDOWN even though the derived state is IDLE
    expect(await refreshAgentState(db, aid, new Date(T.getTime() + 30_000))).toBe('COOLDOWN');
    // refresh AFTER `until` clears to derived
    expect(await refreshAgentState(db, aid, new Date(T.getTime() + 90_000))).toBe('IDLE');
  });

  it('BLOCKED with a null timer is indefinite — refresh keeps it', async () => {
    const aid = await newAgent();
    await addSignal(aid, 'ACTIVE'); // even with an active signal…
    await blockAgent(db, aid, null);
    expect(await refreshAgentState(db, aid)).toBe('BLOCKED'); // …BLOCKED wins
    // unblock clears it back to the derived state (WATCHING, because the signal is still active)
    expect(await unblockAgent(db, aid)).toBe('WATCHING');
  });

  it('tickLifecycle clears expired COOLDOWN + daily-loss BLOCKED back to derived', async () => {
    const aid = await newAgent();
    await blockAgent(db, aid, new Date(T.getTime() + 60_000)); // daily-loss style: has a timer
    const cleared = await tickLifecycle(db, new Date(T.getTime() + 120_000));
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect((await getAgentState(db, aid))!.state).toBe('IDLE');
  });
});
