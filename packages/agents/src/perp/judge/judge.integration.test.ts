import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, closeDb, llmCallLog, signal, signalFeature, signalRisk, type Db } from '@tip/database';
import { ValidationError } from '@tip/domain';
import { EVENT_NAMES, type EventBus } from '@tip/events';
import type { DeepSeekClient } from '@tip/llm';
import type { AgentContext } from '@tip/trading-agents';
import { createJudgeAgent, JUDGE_AGENT_KEY, JUDGE_VERSION_CURRENT } from './index.js';

const DATABASE_URL = process.env.DATABASE_URL;

/** Fake LLM client that returns whatever the test hands it. */
function fakeLLM(response: Parameters<DeepSeekClient['complete']>[0] extends { schema: infer S } ? S : unknown): DeepSeekClient {
  return {
    async complete(_input) {
      return {
        ok: true, value: response as never,
        usage: { promptTokens: 100, completionTokens: 50 },
        latencyMs: 10, model: 'deepseek-v4-flash',
      };
    },
  };
}

function failingLLM(errorKind: 'HTTP_5XX' | 'INVALID_JSON'): DeepSeekClient {
  return {
    async complete() {
      return {
        ok: false, errorKind, message: 'test failure',
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: 5, model: 'deepseek-v4-flash',
      };
    },
  };
}

describe.skipIf(!DATABASE_URL)('perp Judge agent (integration)', () => {
  let db: Db;
  const signalIds: string[] = [];

  async function seedSignal(over: { direction?: string; riskLevel?: string } = {}): Promise<string> {
    const id = randomUUID(); signalIds.push(id);
    await db.insert(signal).values({
      id, tradingAgentId: randomUUID(), symbol: 'BTCUSDT', domain: 'perp',
      direction: over.direction ?? 'LONG', compositeScore: '0.6', confidence: '0.7',
      state: 'ACTIVE', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      configVersion: 1, fingerprint: `j-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    await db.insert(signalFeature).values({
      signalId: id, agentKey: 'perp.momentum', agentVersion: 1,
      score: '0.85', confidence: '0.9', features: {},
    });
    await db.insert(signalRisk).values({
      signalId: id, riskLevel: over.riskLevel ?? 'LOW', riskFlags: [], agentVersion: 1,
    });
    return id;
  }

  function ctx(): AgentContext {
    return {
      db, now: new Date(), tradingAgentId: 'x', configVersion: 1, domain: 'perp',
      primaryTf: '1h', walletScoreAsOf: async () => null, activeClusterMap: async () => new Map(),
    };
  }

  const good = {
    direction: 'SHORT' as const, confidence: 0.75, thesis: 'crowded longs; funding elevated',
    keyRisks: ['funding jumps further'],
    invalidators: [{ type: 'price_above' as const, value: 70000 }],
    confidenceTag: 'moderate' as const,
  };

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      if (signalIds.length) {
        await db.delete(signalRisk).where(inArray(signalRisk.signalId, signalIds));
        await db.delete(signalFeature).where(inArray(signalFeature.signalId, signalIds));
        await db.delete(signal).where(inArray(signal.id, signalIds));
        await db.delete(llmCallLog).where(inArray(llmCallLog.signalId, signalIds));
      }
      await closeDb(db);
    }
  });

  it('memecoin refused with §40.14 citation — silent skip would hide the mismatch', async () => {
    const agent = createJudgeAgent({ llm: fakeLLM(good) });
    const memeCtx: AgentContext = { ...ctx(), domain: 'memecoin' };
    await expect(agent.analyze(
      { id: 'e', type: EVENT_NAMES.SIGNAL_CREATED, version: 1,
        eventTime: 't', processingTime: 't', source: 's',
        payload: { signalId: 'x' } },
      memeCtx,
    )).rejects.toThrow(ValidationError);
  });

  it('Risk INVALIDATED short-circuits — no LLM call, no signal_feature row (§40.14)', async () => {
    const sid = await seedSignal({ riskLevel: 'INVALIDATED' });
    const llm = fakeLLM(good);
    const spy = vi.spyOn(llm, 'complete');
    const agent = createJudgeAgent({ llm });
    const out = await agent.analyze(
      { id: 'e', type: EVENT_NAMES.SIGNAL_CREATED, version: 1,
        eventTime: 't', processingTime: 't', source: 's',
        payload: { signalId: sid } },
      ctx(),
    );
    expect(out).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    const rows = await db.select().from(signalFeature)
      .where(eq(signalFeature.signalId, sid));
    // Only the seeded momentum row exists; no judge row.
    expect(rows.find((r) => r.agentKey === JUDGE_AGENT_KEY)).toBeUndefined();
  });

  it('happy path: SHORT judgment writes a signed signal_feature row + emits judge.evaluation.completed', async () => {
    const sid = await seedSignal();
    const publish = vi.fn(async () => ({ id: 'e' }));
    const bus = { publish } as unknown as EventBus;
    const agent = createJudgeAgent({ llm: fakeLLM(good), bus });

    const out = await agent.analyze(
      { id: 'e', type: EVENT_NAMES.SIGNAL_CREATED, version: 1,
        eventTime: 't', processingTime: 't', source: 's', payload: { signalId: sid } },
      ctx(),
    );
    expect(out).not.toBeNull();
    expect(out!.direction).toBe('SHORT');
    expect(out!.score).toBeCloseTo(-0.75, 6);

    const rows = await db.select().from(signalFeature).where(eq(signalFeature.signalId, sid));
    const judge = rows.find((r) => r.agentKey === JUDGE_AGENT_KEY);
    expect(judge).toBeDefined();
    expect(Number(judge!.score)).toBeCloseTo(-0.75, 6);
    expect(judge!.agentVersion).toBe(JUDGE_VERSION_CURRENT);
    const feats = judge!.features as { thesis: string; judgeDirection: string; judgeAction: null };
    expect(feats.thesis).toContain('crowded longs');
    expect(feats.judgeDirection).toBe('SHORT');
    expect(feats.judgeAction).toBeNull(); // gate stamps this later

    // Event published.
    const call = publish.mock.calls.find((c) => (c[1] as { type: string }).type === EVENT_NAMES.JUDGE_EVALUATION_COMPLETED);
    expect(call).toBeDefined();
    expect((call![1] as { payload: { judgeDirection: string } }).payload.judgeDirection).toBe('SHORT');

    // llm_call_log row is present with signalId set.
    const logs = await db.select().from(llmCallLog).where(eq(llmCallLog.signalId, sid));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.success).toBe(true);
    expect(logs[0]!.agent).toBe('judge');
  });

  it('LLM failure: no signal_feature row, no event — deterministic degrades gracefully (§18)', async () => {
    const sid = await seedSignal();
    const publish = vi.fn(async () => ({ id: 'e' }));
    const bus = { publish } as unknown as EventBus;
    const agent = createJudgeAgent({ llm: failingLLM('HTTP_5XX'), bus });

    const out = await agent.analyze(
      { id: 'e', type: EVENT_NAMES.SIGNAL_CREATED, version: 1,
        eventTime: 't', processingTime: 't', source: 's', payload: { signalId: sid } },
      ctx(),
    );
    expect(out).toBeNull();

    const rows = await db.select().from(signalFeature).where(eq(signalFeature.signalId, sid));
    expect(rows.find((r) => r.agentKey === JUDGE_AGENT_KEY)).toBeUndefined();

    const emitted = publish.mock.calls.filter((c) => (c[1] as { type: string }).type === EVENT_NAMES.JUDGE_EVALUATION_COMPLETED);
    expect(emitted).toHaveLength(0);

    // BUT the llm_call_log row is present with success=false — §23 still needs to see the cost of a try.
    const logs = await db.select().from(llmCallLog).where(eq(llmCallLog.signalId, sid));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.success).toBe(false);
    expect(logs[0]!.errorKind).toBe('HTTP_5XX');
  });
});
