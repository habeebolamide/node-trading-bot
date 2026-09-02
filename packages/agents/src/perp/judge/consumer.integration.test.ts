import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, judgeDecision, scoringConfig, signal, signalFeature, tradingAgent, type Db,
} from '@tip/database';
import { EVENT_NAMES, type EventBus } from '@tip/events';
import { createTradingAgent } from '@tip/trading-agents';
import { handleJudgeEvaluation, JUDGE_VERSION_CURRENT } from './index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const CFG_BASE = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

const noPlanView = async () => null; // any FLIP call ends up refused-by-planner in tests without a real view

describe.skipIf(!DATABASE_URL)('override-gate consumer (integration)', () => {
  let db: Db;
  const created = { agents: [] as string[], signals: [] as string[] };

  async function seedSignal(over: { detDirection?: string; detConfidence?: string; state?: string } = {}): Promise<{ sid: string; agentId: string }> {
    const agent = await createTradingAgent(db, {
      name: `OG-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: CFG_BASE,
    });
    created.agents.push(agent.id);
    const sid = randomUUID(); created.signals.push(sid);
    await db.insert(signal).values({
      id: sid, tradingAgentId: agent.id, symbol: 'BTCUSDT', domain: 'perp',
      direction: over.detDirection ?? 'LONG', compositeScore: '0.6',
      confidence: over.detConfidence ?? '0.45',
      state: over.state ?? 'CONSUMED',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      configVersion: 1, fingerprint: `og-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    await db.insert(signalFeature).values({
      signalId: sid, agentKey: 'judge', agentVersion: JUDGE_VERSION_CURRENT,
      score: '-0.85', confidence: '0.85',
      features: { thesis: 't', keyRisks: [], invalidators: [], judgeDirection: 'SHORT', judgeAction: null },
    });
    return { sid, agentId: agent.id };
  }

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      if (created.signals.length) {
        await db.delete(judgeDecision).where(inArray(judgeDecision.signalId, created.signals));
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

  it('FLIP with a successful planner → writes judge_decision(FLIP), emits signal.flipped, stamps signal_feature', async () => {
    const { sid } = await seedSignal({ detConfidence: '0.45', detDirection: 'LONG' });
    const publish = vi.fn(async () => ({ id: 'e' }));
    const bus = { publish } as unknown as EventBus;
    const runFlipPlanner = vi.fn(async () => ({ ok: true as const, direction: 'SHORT' }));
    const view = { asOf: new Date() } as unknown as import('@tip/evaluation').AsOfMarketData;

    const r = await handleJudgeEvaluation(
      { db, bus, runFlipPlanner },
      { payload: { signalId: sid, judgeVersion: JUDGE_VERSION_CURRENT, judgeDirection: 'SHORT', judgeConfidence: 0.85 } },
      async () => view,
    );
    expect(r?.action).toBe('FLIP');
    expect(r?.refused).toBe(false);
    expect(runFlipPlanner).toHaveBeenCalledOnce();

    const decisions = await db.select().from(judgeDecision).where(eq(judgeDecision.signalId, sid));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.judgeAction).toBe('FLIP');
    expect(decisions[0]!.flipRefusedByPlanner).toBe(false);

    // signal_feature.features stamped with judgeAction: 'FLIP'
    const feat = (await db.select().from(signalFeature)
      .where(and(eq(signalFeature.signalId, sid), eq(signalFeature.agentKey, 'judge'))).limit(1))[0]!;
    expect((feat.features as { judgeAction: string }).judgeAction).toBe('FLIP');

    // signal.flipped published
    const flipEvent = publish.mock.calls.find((c) => (c[1] as { type: string }).type === 'signal.flipped');
    expect(flipEvent).toBeDefined();
  });

  it('FLIP with a REFUSING planner → downgrades to DEFER, no signal.flipped, flipRefusedByPlanner=true', async () => {
    const { sid } = await seedSignal({ detConfidence: '0.45', detDirection: 'LONG' });
    const publish = vi.fn(async () => ({ id: 'e' }));
    const bus = { publish } as unknown as EventBus;
    const runFlipPlanner = vi.fn(async () => ({ ok: false as const, reason: 'INSUFFICIENT_RR' }));

    const r = await handleJudgeEvaluation(
      { db, bus, runFlipPlanner },
      { payload: { signalId: sid, judgeVersion: JUDGE_VERSION_CURRENT, judgeDirection: 'SHORT', judgeConfidence: 0.85 } },
      async () => ({ asOf: new Date() } as unknown as import('@tip/evaluation').AsOfMarketData),
    );
    expect(r?.action).toBe('DEFER');
    expect(r?.refused).toBe(true);
    const decisions = await db.select().from(judgeDecision).where(eq(judgeDecision.signalId, sid));
    expect(decisions[0]!.judgeAction).toBe('DEFER');
    expect(decisions[0]!.flipRefusedByPlanner).toBe(true);
    const flipEvent = publish.mock.calls.find((c) => (c[1] as { type: string }).type === 'signal.flipped');
    expect(flipEvent).toBeUndefined();
  });

  it('STAND_ASIDE → transitions signal to INVALIDATED + emits signal.invalidated', async () => {
    const { sid } = await seedSignal({ detConfidence: '0.9', detDirection: 'LONG', state: 'ACTIVE' });
    const publish = vi.fn(async () => ({ id: 'e' }));
    const bus = { publish } as unknown as EventBus;
    const runFlipPlanner = vi.fn(async () => ({ ok: true as const, direction: 'SHORT' }));

    const r = await handleJudgeEvaluation(
      { db, bus, runFlipPlanner },
      { payload: { signalId: sid, judgeVersion: JUDGE_VERSION_CURRENT, judgeDirection: 'SHORT', judgeConfidence: 0.55 } },
      noPlanView,
    );
    expect(r?.action).toBe('STAND_ASIDE');
    expect(runFlipPlanner).not.toHaveBeenCalled();

    const s = (await db.select({ state: signal.state }).from(signal).where(eq(signal.id, sid)))[0]!;
    expect(s.state).toBe('INVALIDATED');
    const inv = publish.mock.calls.find((c) => (c[1] as { type: string }).type === EVENT_NAMES.SIGNAL_INVALIDATED);
    expect(inv).toBeDefined();
    const decisions = await db.select().from(judgeDecision).where(eq(judgeDecision.signalId, sid));
    expect(decisions[0]!.judgeAction).toBe('STAND_ASIDE');
  });

  it('DEFER-with-disagreement still writes judge_decision for §23 dissent reporting', async () => {
    const { sid } = await seedSignal({ detConfidence: '0.9', detDirection: 'LONG' });
    const publish = vi.fn(async () => ({ id: 'e' }));
    const runFlipPlanner = vi.fn(async () => ({ ok: true as const, direction: 'SHORT' }));
    const r = await handleJudgeEvaluation(
      { db, bus: { publish } as unknown as EventBus, runFlipPlanner },
      { payload: { signalId: sid, judgeVersion: JUDGE_VERSION_CURRENT, judgeDirection: 'SHORT', judgeConfidence: 0.75 } },
      noPlanView,
    );
    expect(r?.action).toBe('DEFER');
    const decisions = await db.select().from(judgeDecision).where(eq(judgeDecision.signalId, sid));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.judgeAction).toBe('DEFER');
    expect(runFlipPlanner).not.toHaveBeenCalled();
  });

  it('idempotent by (signalId, judgeVersion) — a re-delivered event does not double-write', async () => {
    const { sid } = await seedSignal({ detConfidence: '0.9', detDirection: 'LONG' });
    const runFlipPlanner = vi.fn(async () => ({ ok: true as const, direction: 'SHORT' }));
    const evt = { payload: { signalId: sid, judgeVersion: JUDGE_VERSION_CURRENT, judgeDirection: 'SHORT', judgeConfidence: 0.55 } };
    await handleJudgeEvaluation({ db, runFlipPlanner }, evt, noPlanView);
    await handleJudgeEvaluation({ db, runFlipPlanner }, evt, noPlanView);
    const decisions = await db.select().from(judgeDecision).where(eq(judgeDecision.signalId, sid));
    expect(decisions).toHaveLength(1);
    void sql;
  });
});
