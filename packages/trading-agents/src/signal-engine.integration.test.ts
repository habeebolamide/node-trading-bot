import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, closeDb, signal, signalFeature, tradingAgent, scoringConfig, type Db } from '@tip/database';
import { EVENT_NAMES, type EventBus } from '@tip/events';
import { SignalEngine, type TradingAgentSnapshot } from './signal-engine.js';
import type { AgentOutput } from './agent-interface.js';
import type { ScoringConfig } from './config.js';
import { createTradingAgent } from './store.js';

const DATABASE_URL = process.env.DATABASE_URL;

const perpConfig = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 2, leverageMax: 10,
  agentWeights: { 'perp.momentum': 0.5, 'perp.funding': 0.5 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('SignalEngine (integration, Postgres)', () => {
  let db: Db;
  let tradingAgentId: string;
  let publish: ReturnType<typeof vi.fn>;
  let bus: EventBus;
  const created: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const agent = await createTradingAgent(db, {
      name: `SE-${randomUUID().slice(0, 6)}`,
      domain: 'perp',
      universe: ['BTCUSDT'],
      tradingStyle: 'day',
      config: perpConfig,
    });
    tradingAgentId = agent.id;
    created.push(agent.id);
    publish = vi.fn(async () => ({ id: 'e' }));
    bus = { publish } as unknown as EventBus;
  });

  afterAll(async () => {
    if (db) {
      const signalRows = await db.select({ id: signal.id }).from(signal).where(eq(signal.tradingAgentId, tradingAgentId));
      const signalIds = signalRows.map((r) => r.id);
      if (signalIds.length > 0) {
        await db.delete(signalFeature).where(inArray(signalFeature.signalId, signalIds));
        await db.delete(signal).where(inArray(signal.id, signalIds));
      }
      for (const id of created) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  function makeEngine() {
    const lookup = vi.fn(async (id: string): Promise<TradingAgentSnapshot | null> =>
      id !== tradingAgentId ? null : { id, domain: 'perp', tradingStyle: 'day', configVersion: 1, config: perpConfig as ScoringConfig },
    );
    const engine = new SignalEngine({ db, bus, lookupAgent: lookup, debounceMs: 50 });
    return { engine };
  }

  it('two agent outputs → aggregator flushes → signal + signal_feature rows + published events', async () => {
    const { engine } = makeEngine();
    const bucket = { tradingAgentId, symbol: 'BTCUSDT', primaryTfCloseAt: new Date('2026-06-01T00:00:00Z') };
    const outs: AgentOutput[] = [
      { agent: 'perp.momentum', agentVersion: 1, direction: 'LONG', score: 0.8, confidence: 0.9, features: { rsi: 62 } },
      { agent: 'perp.funding', agentVersion: 1, direction: 'LONG', score: 0.6, confidence: 0.8, features: { fundingPct: 12 } },
    ];
    engine.admit(bucket, outs[0]!);
    engine.admit(bucket, outs[1]!);
    await engine.forceFlushBucket(bucket); // deterministic — awaits the whole write chain

    const rows = await db.select().from(signal).where(eq(signal.tradingAgentId, tradingAgentId));
    expect(rows).toHaveLength(1);
    const s = rows[0]!;
    expect(s.direction).toBe('STRONG_LONG'); // composite = 0.7 → strong_long inclusive
    expect(Number(s.compositeScore)).toBeCloseTo(0.7, 6);
    expect(s.state).toBe('ACTIVE');
    expect(s.configVersion).toBe(1);

    const features = await db.select().from(signalFeature).where(eq(signalFeature.signalId, s.id));
    expect(features).toHaveLength(2);

    const types = publish.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(types).toContain(EVENT_NAMES.SIGNAL_CREATED);
    expect(types).toContain(EVENT_NAMES.PERP_SIGNAL_CREATED);
  });

  it('re-arrival with same fingerprint → DB unique constraint dedups, no new signal', async () => {
    const { engine } = makeEngine();
    // Same bucket close-time as prior test → same fingerprint.
    const bucket = { tradingAgentId, symbol: 'BTCUSDT', primaryTfCloseAt: new Date('2026-06-01T00:00:00Z') };
    engine.admit(bucket, { agent: 'perp.momentum', agentVersion: 1, direction: 'LONG', score: 0.8, confidence: 0.9, features: {} });
    engine.admit(bucket, { agent: 'perp.funding', agentVersion: 1, direction: 'LONG', score: 0.6, confidence: 0.8, features: {} });
    await engine.forceFlushBucket(bucket);

    const rows = await db.select().from(signal).where(eq(signal.tradingAgentId, tradingAgentId));
    expect(rows).toHaveLength(1); // still one row
  });
});
