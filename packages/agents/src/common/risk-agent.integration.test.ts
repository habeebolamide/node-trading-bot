import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, closeDb, signal, signalRisk, tradingAgent, scoringConfig, type Db } from '@tip/database';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext } from '@tip/trading-agents';
import { createTradingAgent } from '@tip/trading-agents';
import { createRiskAgent } from './risk-agent.js';

const DATABASE_URL = process.env.DATABASE_URL;

const perpConfig = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('Risk Agent (integration, Postgres)', () => {
  let db: Db;
  const created: string[] = [];
  const signalIds: string[] = [];

  async function seedSignal(agentId: string, direction: string): Promise<string> {
    const id = randomUUID();
    await db.insert(signal).values({
      id, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp',
      direction, compositeScore: '0.6', confidence: '0.7',
      state: 'ACTIVE', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      configVersion: 1, fingerprint: `test-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    signalIds.push(id);
    return id;
  }

  function makeCtx(): AgentContext {
    return {
      db, now: new Date(), tradingAgentId: 'x', configVersion: 1, domain: 'perp', primaryTf: '1h',
      walletScoreAsOf: async () => null, activeClusterMap: async () => new Map(),
    };
  }

  function event(signalId: string, direction = 'LONG') {
    return {
      id: 'e', type: EVENT_NAMES.SIGNAL_CREATED, version: 1,
      eventTime: new Date().toISOString(), processingTime: new Date().toISOString(), source: 'signal-engine',
      payload: {
        signalId, tradingAgentId: created[0], symbol: 'BTCUSDT', domain: 'perp',
        direction, compositeScore: 0.6, confidence: 0.7, configVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const agent = await createTradingAgent(db, {
      name: `RA-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: perpConfig,
    });
    created.push(agent.id);
  });
  afterAll(async () => {
    if (db) {
      if (signalIds.length) {
        await db.delete(signalRisk).where(inArray(signalRisk.signalId, signalIds));
        await db.delete(signal).where(inArray(signal.id, signalIds));
      }
      for (const id of created) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('writes signal_risk = LOW when checks are clean, signal stays ACTIVE', async () => {
    const id = await seedSignal(created[0]!, 'LONG');
    const loader = async () => ({
      direction: 'LONG' as const, entryPrice: 100, atr14: 5,
      nearestSupport: 90, nearestResistance: 110,
      fundingPercentile30d: 0.5, oiPercentile30d: 0.5, atrRatio: 1.0, emaDistanceInAtr: 0,
    });
    const agent = createRiskAgent({ loadPerpInputs: loader });
    const out = await agent.analyze(event(id), makeCtx());
    expect(out).not.toBeNull();
    expect((out!.features as { riskLevel: string }).riskLevel).toBe('LOW');

    const risk = await db.select().from(signalRisk).where(eq(signalRisk.signalId, id));
    expect(risk).toHaveLength(1);
    expect(risk[0]!.riskLevel).toBe('LOW');

    const s = await db.select().from(signal).where(eq(signal.id, id));
    expect(s[0]!.state).toBe('ACTIVE');
  });

  it('INVALIDATED-level verdict flips signal state and publishes signal.invalidated', async () => {
    const id = await seedSignal(created[0]!, 'LONG');
    const publish = vi.fn(async () => ({ id: 'e' }));
    const bus = { publish } as unknown as import('@tip/events').EventBus;
    // 4 flags → INVALIDATED
    const loader = async () => ({
      direction: 'LONG' as const, entryPrice: 100, atr14: 5,
      nearestSupport: 90, nearestResistance: 101, // SR proximity
      fundingPercentile30d: 0.97, oiPercentile30d: 0.95, atrRatio: 2.5, emaDistanceInAtr: 3,
    });
    const agent = createRiskAgent({ loadPerpInputs: loader, bus });
    const out = await agent.analyze(event(id), makeCtx());
    expect((out!.features as { riskLevel: string }).riskLevel).toBe('INVALIDATED');

    const s = await db.select().from(signal).where(eq(signal.id, id));
    expect(s[0]!.state).toBe('INVALIDATED');

    const invalidatedPublished = publish.mock.calls.some((c) => (c[1] as { type: string }).type === EVENT_NAMES.SIGNAL_INVALIDATED);
    expect(invalidatedPublished).toBe(true);
  });

  it('skips non-ACTIVE signals (idempotent)', async () => {
    const id = await seedSignal(created[0]!, 'LONG');
    await db.update(signal).set({ state: 'INVALIDATED' }).where(eq(signal.id, id));
    const agent = createRiskAgent({ loadPerpInputs: async () => ({
      direction: 'LONG' as const, entryPrice: 100, atr14: 5, nearestSupport: 90, nearestResistance: 110,
      fundingPercentile30d: 0.5, oiPercentile30d: 0.5, atrRatio: 1.0, emaDistanceInAtr: 0,
    }) });
    const out = await agent.analyze(event(id), makeCtx());
    expect(out).toBeNull();
    const risk = await db.select().from(signalRisk).where(eq(signalRisk.signalId, id));
    expect(risk).toHaveLength(0);
  });
});
