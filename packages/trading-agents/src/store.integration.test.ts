import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, closeDb, tradingAgent, scoringConfig, type Db } from '@tip/database';
import { createTradingAgent, getTradingAgent, updateTradingAgentConfig } from './store.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('trading-agent store (integration, Postgres)', () => {
  let db: Db;
  const created: string[] = [];

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      for (const id of created) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('creates a TradingAgent with v1 config, then PATCH creates v2 and flips active atomically', async () => {
    const created1 = await createTradingAgent(db, {
      name: `IT-${randomUUID().slice(0, 6)}`,
      domain: 'perp',
      universe: ['BTCUSDT'],
      tradingStyle: 'day',
      config: {
        riskPercent: 0.01,
        minRR: 1.5,
        maxConcurrentPositions: 2,
        leverageMax: 10,
        agentWeights: { 'perp.momentum': 0.2 },
        signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
      },
    });
    created.push(created1.id);
    expect(created1.activeConfigVersion).toBe(1);
    expect(created1.config.riskPercent).toBeCloseTo(0.01, 6);

    // Round-trip
    const fetched = await getTradingAgent(db, created1.id);
    expect(fetched?.name).toBe(created1.name);

    // PATCH → v2, old v1 stays but active flips to false
    const v2 = await updateTradingAgentConfig(db, created1.id, {
      riskPercent: 0.02,
      minRR: 2,
      maxConcurrentPositions: 2,
      leverageMax: 10,
      agentWeights: { 'perp.momentum': 0.3, 'perp.funding': 0.1 },
      signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
    });
    expect(v2.activeConfigVersion).toBe(2);
    expect(v2.config.riskPercent).toBeCloseTo(0.02, 6);

    // Both rows exist; only v2 is active.
    const rows = await db
      .select({ version: scoringConfig.version, active: scoringConfig.active })
      .from(scoringConfig)
      .where(eq(scoringConfig.tradingAgentId, created1.id));
    expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
    const activeRows = rows.filter((r) => r.active);
    expect(activeRows.map((r) => r.version)).toEqual([2]);
  });
});
