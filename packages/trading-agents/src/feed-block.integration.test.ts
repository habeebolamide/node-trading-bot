import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, closeDb, scoringConfig, tradingAgent, type Db } from '@tip/database';
import { createTradingAgent } from './store.js';
import { blockAgentsForStaleFeed, unblockAgentsForRecoveredFeed } from './feed-block.js';
import { blockAgent, getAgentState } from './agent-lifecycle.js';

const DATABASE_URL = process.env.DATABASE_URL;
const cfg = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

/**
 * Integration coverage for the audit-2 corrected behaviour. Real production feed ids in
 * @tip/ingestion are symbol-less today (`bybit.kline.<tf>`, `bybit.tickers`, etc.), so
 * blockAgentsForStaleFeed(id) blocks EVERY perp agent — conservative and correct until
 * per-symbol feed ids land. A future per-symbol id like `klines.BTCUSDT.1h` will scope to
 * BTCUSDT-universe agents only, which the forward-compatibility case at the bottom pins.
 */
describe.skipIf(!DATABASE_URL)('feed-block bridge (integration)', () => {
  let db: Db;
  const created: string[] = [];
  async function agent(symbol: string) {
    const a = await createTradingAgent(db, { name: `FB-${randomUUID().slice(0,6)}`, domain: 'perp', universe: [symbol], tradingStyle: 'day', config: cfg });
    created.push(a.id);
    return a.id;
  }
  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      // Reset lifecycle to unblock any BLOCKED rows so the delete cleanly cascades in a shared DB.
      if (created.length > 0) {
        await db.update(tradingAgent).set({ lifecycleState: 'IDLE', lifecycleUntil: null })
          .where(inArray(tradingAgent.id, created));
      }
      for (const id of created) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('a symbol-less bybit feed id blocks every perp agent (current production shape)', async () => {
    const btc = await agent('BTCUSDT');
    const eth = await agent('ETHUSDT');
    const blocked = await blockAgentsForStaleFeed(db, 'bybit.kline.1h');
    expect(blocked).toContain(btc);
    expect(blocked).toContain(eth);
    expect((await getAgentState(db, btc))!.state).toBe('BLOCKED');
    expect((await getAgentState(db, eth))!.state).toBe('BLOCKED');
  });

  it('recovery clears feed-staleness blocks (null timer) but not daily-loss blocks (timed)', async () => {
    const btc = await agent('BTCUSDT');
    const btc2 = await agent('BTCUSDT');
    await blockAgentsForStaleFeed(db, 'bybit.kline.1h'); // both → BLOCKED, until=null
    await blockAgent(db, btc2, new Date(Date.now() + 3600_000)); // btc2 → daily-loss-style BLOCKED w/ timer
    const cleared = await unblockAgentsForRecoveredFeed(db, 'bybit.kline.1h');
    expect(cleared).toContain(btc);       // feed-staleness block cleared
    expect(cleared).not.toContain(btc2);  // timed block left alone
    expect((await getAgentState(db, btc2))!.state).toBe('BLOCKED');
  });

  it('forward-compat: a per-symbol feed id scopes to universe-matching agents only', async () => {
    const sol = await agent('SOLUSDT');
    const btcOnly = await agent('BTCUSDT');
    const blocked = await blockAgentsForStaleFeed(db, 'klines.SOLUSDT.1h');
    expect(blocked).toContain(sol);
    expect(blocked).not.toContain(btcOnly);
  });
});
