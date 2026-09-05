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
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
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

  // Grouping is now by CATEGORY across setups (2026-09-05), so isolation is per-category, not
  // per-setup. below-floor and above-floor use DISTINCT known categories to avoid accumulating
  // into the same bucket. beforeAll clears any prior-run residue for these categories (safe on a
  // dedicated test DB — the only place DATABASE_URL should point for integration tests).
  const FLOOR_CAT = 'LIQUIDATION_SIGNAL_MISSED'; // below-floor test
  const PROP_CAT = 'POSITIONING_MISREAD';        // above-floor + promotion test

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    // Clean slate for the categories this suite asserts on.
    await db.delete(learningHypothesis).where(and(
      eq(learningHypothesis.setupId, 'ALL'),
      inArray(learningHypothesis.category, [FLOOR_CAT, PROP_CAT]),
    ));
    await db.delete(tradeAutopsy).where(and(
      eq(tradeAutopsy.status, 'SUCCESS'),
      inArray(tradeAutopsy.failureCategory, [FLOOR_CAT, PROP_CAT]),
    ));
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

  it('below effective-n floor → NO proposal (§24 gate)', async () => {
    // Only 5 losses of FLOOR_CAT — below the floor (10). Distinct category from the above-floor test.
    for (let i = 0; i < 5; i++) await seedAutopsy({ outcome: 'LOSS', category: FLOOR_CAT });
    const r = await openHypotheses({ db, asOf: AS_OF });
    const mine = r.proposals.filter((p) => p.category === FLOOR_CAT);
    expect(mine).toHaveLength(0);
    const rows = await db.select({ id: learningHypothesis.id }).from(learningHypothesis)
      .where(and(eq(learningHypothesis.setupId, 'ALL'), eq(learningHypothesis.category, FLOOR_CAT)));
    expect(rows).toHaveLength(0);
  });

  it('above the floor → proposal + PROPOSED row for a known FAILURE category', async () => {
    // 25 losses of PROP_CAT (across arbitrary setups) clears 20 even after decay.
    for (let i = 0; i < 25; i++) await seedAutopsy({ outcome: 'LOSS', category: PROP_CAT, setupId: `hyp-${randomUUID().slice(0, 8)}` });
    const r = await openHypotheses({ db, asOf: AS_OF });
    const mine = r.proposals.filter((p) => p.category === PROP_CAT);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0]!.setupId).toBe('ALL'); // category-level sentinel
    expect(mine[0]!.proposedChange).toEqual({ kind: 'weightDelta', agentKey: 'perp.positioning', delta: 0.03 });

    const rows = await db.select().from(learningHypothesis)
      .where(and(eq(learningHypothesis.setupId, 'ALL'), eq(learningHypothesis.category, PROP_CAT)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PROPOSED');
    created.hypotheses.push(rows[0]!.id);
  });

  it('a second sweep with the same evidence does NOT open a duplicate (idempotent per PROPOSED)', async () => {
    const r = await openHypotheses({ db, asOf: AS_OF });
    const mine = r.proposals.filter((p) => p.category === PROP_CAT);
    // The proposal is still emitted (aggregation surfaces it), but no NEW row gets inserted
    // because the previous test's row is still PROPOSED.
    if (mine.length > 0) expect(r.alreadyOpen).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(learningHypothesis)
      .where(and(eq(learningHypothesis.setupId, 'ALL'), eq(learningHypothesis.category, PROP_CAT)));
    expect(rows).toHaveLength(1); // still one
  });

  it('unknown categories are skipped (skippedNoMapping counts them)', async () => {
    // Seed enough of an unknown category to clear the floor.
    for (let i = 0; i < 22; i++) await seedAutopsy({ outcome: 'LOSS', category: 'INVENTED_CATEGORY_XYZ', setupId: `hyp-unk-${randomUUID().slice(0, 8)}` });
    const r = await openHypotheses({ db, asOf: AS_OF });
    // At least one unknown pattern skipped this sweep.
    expect(r.skippedNoMapping).toBeGreaterThanOrEqual(1);
    const rows = await db.select({ id: learningHypothesis.id })
      .from(learningHypothesis).where(eq(learningHypothesis.category, 'INVENTED_CATEGORY_XYZ'));
    expect(rows).toHaveLength(0);
  });

  it('PROMOTION: takes an OOS_PASSED hypothesis, inserts a NEW scoring_config row, marks PROMOTED', async () => {
    // Move the earlier PROPOSED row to OOS_PASSED (audit-3 fix: BACKTEST_PASSED alone no
    // longer promotes — OOS must confirm). mimicking a passing backtest + OOS confirmation.
    const rows = await db.select().from(learningHypothesis)
      .where(and(eq(learningHypothesis.setupId, 'ALL'), eq(learningHypothesis.category, 'POSITIONING_MISREAD')));
    const h = rows[0]!;
    await db.update(learningHypothesis).set({ status: 'OOS_PASSED' }).where(eq(learningHypothesis.id, h.id));

    // Read current active version (v1) → after promotion we expect v2.
    const beforeActive = (await db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, agentId), eq(scoringConfig.active, true))))[0]!;

    const result = await promoteHypothesis(db, {
      hypothesisId: h.id, tradingAgentId: agentId, style: 'day',
      minPredictionsForBootstrap: 0, // test seeds autopsies but no predictions; bypass the guard
    });
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
      .where(and(eq(learningHypothesis.setupId, 'ALL'), eq(learningHypothesis.status, 'PROMOTED'))))[0];
    // A PROMOTED row cannot be re-promoted.
    if (proposedRow) {
      const r = await promoteHypothesis(db, { hypothesisId: proposedRow.id, tradingAgentId: agentId, style: 'day' });
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

  it('floor sanity check — HYPOTHESIS_ELIGIBILITY_FLOOR lowered to 10 (matches Setup Memory trust floor; plan D10)', () => {
    expect(HYPOTHESIS_ELIGIBILITY_FLOOR).toBe(10);
  });
});
