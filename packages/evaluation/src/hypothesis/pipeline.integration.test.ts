import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  createDb, closeDb, learningHypothesis, scoringConfig,
  tradeAutopsy, tradingAgent, type Db,
} from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import { openHypotheses } from './pipeline.js';
import { promoteHypothesis } from './promote.js';
import { HYPOTHESIS_ELIGIBILITY_FLOOR } from './aggregate.js';

const DATABASE_URL = process.env.DATABASE_URL;
const CFG = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 2, leverageMax: 10,
  agentWeights: { 'perp.momentum': 0.5, 'perp.positioning': 0.5 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

const T = new Date('2026-08-31T12:00:00Z');
const AS_OF = new Date('2026-08-31T13:00:00Z');

describe.skipIf(!DATABASE_URL)('hypothesis pipeline (integration)', () => {
  let db: Db;
  let agentId: string;
  const created = { agents: [] as string[], autopsies: [] as string[], hypotheses: [] as string[] };
  const uniqueSetup = `hyp-${randomUUID().slice(0, 10)}`;

  async function seedAutopsy(over: {
    outcome: 'WIN' | 'LOSS';
    setupId?: string; category: string;
    createdAt?: Date;
  }): Promise<void> {
    const id = randomUUID(); created.autopsies.push(id);
    await db.insert(tradeAutopsy).values({
      id,
      predictionId: randomUUID(),
      setupId: over.setupId ?? uniqueSetup,
      outcome: over.outcome,
      rootCause: 'r',
      failureCategory: over.outcome === 'LOSS' ? over.category : null,
      successFactor:   over.outcome === 'WIN'  ? over.category : null,
      explanation: 'e', contributingFactors: [], agentFailures: [],
      lesson: 'l', recommendation: 'r',
      autopsyVersion: 1, llmCallLogId: null, status: 'SUCCESS',
      createdAt: over.createdAt ?? T,
    });
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `HP-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: CFG,
    });
    agentId = a.id; created.agents.push(agentId);
  });

  afterAll(async () => {
    if (db) {
      if (created.hypotheses.length) await db.delete(learningHypothesis).where(inArray(learningHypothesis.id, created.hypotheses));
      if (created.autopsies.length) await db.delete(tradeAutopsy).where(inArray(tradeAutopsy.id, created.autopsies));
      for (const id of created.agents) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('below effective-n floor → NO proposal (§24 ≥ 20 gate)', async () => {
    // Only 5 losses of the same category — well below 20.
    for (let i = 0; i < 5; i++) await seedAutopsy({ outcome: 'LOSS', category: 'POSITIONING_MISREAD' });
    const r = await openHypotheses({ db, asOf: AS_OF });
    // Filter to only THIS test's setupId — there may be prior test runs' data too.
    const mine = r.proposals.filter((p) => p.setupId === uniqueSetup);
    expect(mine).toHaveLength(0);
    // No hypothesis row for this setup either.
    const rows = await db.select({ id: learningHypothesis.id }).from(learningHypothesis)
      .where(eq(learningHypothesis.setupId, uniqueSetup));
    expect(rows).toHaveLength(0);
  });

  it('above the floor → proposal + PROPOSED row for a known FAILURE category', async () => {
    // Add 20 more (total 25 for this setup) so effective-n well clears 20 even after decay.
    for (let i = 0; i < 20; i++) await seedAutopsy({ outcome: 'LOSS', category: 'POSITIONING_MISREAD' });
    const r = await openHypotheses({ db, asOf: AS_OF });
    const mine = r.proposals.filter((p) => p.setupId === uniqueSetup);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0]!.proposedChange).toEqual({ kind: 'weightDelta', agentKey: 'perp.positioning', delta: 0.03 });

    const rows = await db.select().from(learningHypothesis)
      .where(and(eq(learningHypothesis.setupId, uniqueSetup), eq(learningHypothesis.category, 'POSITIONING_MISREAD')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PROPOSED');
    created.hypotheses.push(rows[0]!.id);
  });

  it('a second sweep with the same evidence does NOT open a duplicate (idempotent per PROPOSED)', async () => {
    const r = await openHypotheses({ db, asOf: AS_OF });
    const mine = r.proposals.filter((p) => p.setupId === uniqueSetup);
    // The proposal is still emitted (aggregation surfaces it), but no NEW row gets inserted
    // because the previous test's row is still PROPOSED.
    if (mine.length > 0) expect(r.alreadyOpen).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(learningHypothesis)
      .where(and(eq(learningHypothesis.setupId, uniqueSetup), eq(learningHypothesis.category, 'POSITIONING_MISREAD')));
    expect(rows).toHaveLength(1); // still one
  });

  it('unknown categories are skipped (skippedNoMapping counts them)', async () => {
    // Seed enough of an unknown category to clear the floor.
    const unknownSetup = `hyp-unk-${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 22; i++) await seedAutopsy({ outcome: 'LOSS', category: 'INVENTED_CATEGORY_XYZ', setupId: unknownSetup });
    const r = await openHypotheses({ db, asOf: AS_OF });
    // At least one unknown pattern skipped this sweep.
    expect(r.skippedNoMapping).toBeGreaterThanOrEqual(1);
    const rows = await db.select({ id: learningHypothesis.id })
      .from(learningHypothesis).where(eq(learningHypothesis.setupId, unknownSetup));
    expect(rows).toHaveLength(0);
  });

  it('PROMOTION: takes a BACKTEST_PASSED hypothesis, inserts a NEW scoring_config row, marks PROMOTED', async () => {
    // Move the earlier PROPOSED row to BACKTEST_PASSED (mimicking a passing backtest + OOS).
    const rows = await db.select().from(learningHypothesis)
      .where(and(eq(learningHypothesis.setupId, uniqueSetup), eq(learningHypothesis.category, 'POSITIONING_MISREAD')));
    const h = rows[0]!;
    await db.update(learningHypothesis).set({ status: 'BACKTEST_PASSED' }).where(eq(learningHypothesis.id, h.id));

    // Read current active version (v1) → after promotion we expect v2.
    const beforeActive = (await db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, agentId), eq(scoringConfig.active, true))))[0]!;

    const result = await promoteHypothesis(db, { hypothesisId: h.id, tradingAgentId: agentId });
    expect(result.promoted).toBe(true);
    expect(result.fromConfigVersion).toBe(beforeActive.version);
    expect(result.toConfigVersion).toBe(beforeActive.version + 1);

    // Old row still exists (rule 16 — never touch old rows), active=false.
    const oldRow = (await db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, agentId), eq(scoringConfig.version, beforeActive.version))))[0]!;
    expect(oldRow.active).toBe(false);
    // New row exists and is active.
    const newActive = (await db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, agentId), eq(scoringConfig.active, true))))[0]!;
    expect(newActive.version).toBe(beforeActive.version + 1);
    const cfg = newActive.config as { agentWeights: Record<string, number> };
    // Positioning weight went up.
    expect(cfg.agentWeights['perp.positioning']!).toBeGreaterThan(0.5);
    const total = Object.values(cfg.agentWeights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);

    // Hypothesis marked PROMOTED with version links.
    const afterH = (await db.select().from(learningHypothesis).where(eq(learningHypothesis.id, h.id)))[0]!;
    expect(afterH.status).toBe('PROMOTED');
    expect(afterH.fromConfigVersion).toBe(beforeActive.version);
    expect(afterH.toConfigVersion).toBe(beforeActive.version + 1);
  });

  it('a hypothesis in a non-promotable status is refused', async () => {
    const proposedRow = (await db.select().from(learningHypothesis)
      .where(and(eq(learningHypothesis.setupId, uniqueSetup), eq(learningHypothesis.status, 'PROMOTED'))))[0];
    // A PROMOTED row cannot be re-promoted.
    if (proposedRow) {
      const r = await promoteHypothesis(db, { hypothesisId: proposedRow.id, tradingAgentId: agentId });
      expect(r.promoted).toBe(false);
      expect(r.reason).toContain('not promotable');
    }
  });

  it('structural: propose.ts has NO LLM import (§16 descriptive-not-prescriptive; §33 rule 13)', async () => {
    const src = await readFile(fileURLToPath(new URL('./propose.ts', import.meta.url)), 'utf8');
    // Strip comments first — the docstring naturally mentions "LLM"; that's not an import.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/@tip\/llm/);
    expect(code).not.toMatch(/deepseek/i);
    expect(code).not.toMatch(/callWithLog|createDeepSeekClient/);
  });

  it('floor sanity check — HYPOTHESIS_ELIGIBILITY_FLOOR is 20 (§24, higher than Setup Memory\'s 10)', () => {
    expect(HYPOTHESIS_ELIGIBILITY_FLOOR).toBe(20);
  });
});
