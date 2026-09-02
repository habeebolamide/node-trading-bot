import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, closeDb, brainAgentMemory, brainAgentOccurrence, type Db } from '@tip/database';
import {
  recordAgentOutcome, agentMemoryAsOf, persistAgentMemory,
  type AgentContribution, type ResolvedPrediction,
} from './agent-memory.js';
import { createBrain } from './brain.js';
import { wilsonInterval, recencyWeight } from './stats.js';
import { HALFLIFE_DAYS } from './setup-memory.js';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const T = new Date('2026-08-01T00:00:00Z');

describe.skipIf(!DATABASE_URL)('Agent Memory (integration, Postgres)', () => {
  let db: Db;
  const agentKeys: string[] = [];
  const predictionIds: string[] = [];

  /** Unique agent key per test so a shared DB cannot contaminate counts. */
  function newAgent(): string {
    const k = `test.agent.${randomUUID().slice(0, 8)}`;
    agentKeys.push(k);
    return k;
  }

  async function resolve(
    contributions: readonly AgentContribution[],
    realizedDirection: 1 | -1,
    closedAt = T,
  ): Promise<string> {
    const predictionId = randomUUID();
    predictionIds.push(predictionId);
    const p: ResolvedPrediction = { predictionId, domain: 'perp', closedAt, realizedDirection };
    await recordAgentOutcome(db, p, contributions);
    return predictionId;
  }

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      if (agentKeys.length) {
        await db.delete(brainAgentOccurrence).where(inArray(brainAgentOccurrence.agentKey, agentKeys));
        await db.delete(brainAgentMemory).where(inArray(brainAgentMemory.agentKey, agentKeys));
      }
      await closeDb(db);
    }
  });

  it('an agent with no occurrences returns NULL — distinct from INSUFFICIENT', async () => {
    expect(await agentMemoryAsOf(db, 'perp', newAgent(), 1, T)).toBeNull();
  });

  it('THE CORE MECHANISM: a dissenter is credited when the composite loses and the dissent was right', async () => {
    const follower = newAgent();  // leaned with the losing composite
    const dissenter = newAgent(); // leaned against it, and was right
    // Realized direction was SHORT (−1); the composite went LONG and lost.
    for (let i = 0; i < 12; i++) {
      await resolve([
        { agent: follower, agentVersion: 1, score: 0.8 },   // LONG lean — wrong
        { agent: dissenter, agentVersion: 1, score: -0.8 }, // SHORT lean — right
      ], -1);
    }

    const f = await agentMemoryAsOf(db, 'perp', follower, 1, T);
    const d = await agentMemoryAsOf(db, 'perp', dissenter, 1, T);
    expect(f!.standaloneAccuracy).toBe(0); // agreeing with a loser is debited
    expect(d!.standaloneAccuracy).toBe(1); // dissenting correctly is credited
    expect(d!.evidence).toBe('SUFFICIENT');
  });

  it('zero-lean agents are not recorded at all — silence earns neither credit nor blame', async () => {
    const silent = newAgent();
    for (let i = 0; i < 5; i++) {
      await resolve([{ agent: silent, agentVersion: 1, score: 0 }], 1);
    }
    expect(await agentMemoryAsOf(db, 'perp', silent, 1, T)).toBeNull();
  });

  it('excluded agents (Token Risk / Risk) produce no occurrences', async () => {
    const pid = await resolve([
      { agent: 'memecoin.token_risk', agentVersion: 1, score: 1 },
      { agent: 'risk', agentVersion: 1, score: -1 },
    ], 1);
    const rows = await db.select().from(brainAgentOccurrence).where(inArray(brainAgentOccurrence.predictionId, [pid]));
    expect(rows).toHaveLength(0);
  });

  it('VERSIONS NEVER BLEND: v2 reads INSUFFICIENT while v1 is rich', async () => {
    const key = newAgent();
    for (let i = 0; i < 30; i++) {
      await resolve([{ agent: key, agentVersion: 1, score: 0.9 }], 1); // v1: 30 wins
    }
    for (let i = 0; i < 2; i++) {
      await resolve([{ agent: key, agentVersion: 2, score: 0.9 }], -1); // v2: 2 losses
    }

    const v1 = await agentMemoryAsOf(db, 'perp', key, 1, T);
    const v2 = await agentMemoryAsOf(db, 'perp', key, 2, T);
    expect(v1!.evidence).toBe('SUFFICIENT');
    expect(v1!.standaloneAccuracy).toBe(1);
    expect(v2!.evidence).toBe('INSUFFICIENT');   // thin on its own merits
    expect(v2!.standaloneAccuracy).toBe(0);      // NOT rescued by v1's record
    expect(v2!.occurrenceCount).toBe(2);
  });

  it('is idempotent — replaying a resolved prediction does not double-count', async () => {
    const key = newAgent();
    const predictionId = randomUUID();
    predictionIds.push(predictionId);
    const p: ResolvedPrediction = { predictionId, domain: 'perp', closedAt: T, realizedDirection: 1 };
    const contributions = [{ agent: key, agentVersion: 1, score: 0.5 }];

    await recordAgentOutcome(db, p, contributions);
    await recordAgentOutcome(db, p, contributions);
    const mem = await agentMemoryAsOf(db, 'perp', key, 1, T);
    expect(mem!.occurrenceCount).toBe(1);
  });

  it('statistics match the shared helpers exactly — no second implementation (§41)', async () => {
    const key = newAgent();
    for (let i = 0; i < 15; i++) {
      await resolve([{ agent: key, agentVersion: 1, score: 0.5 }], i < 11 ? 1 : -1); // 11/15
    }
    const mem = await agentMemoryAsOf(db, 'perp', key, 1, T);
    const expected = wilsonInterval(11, 15, 0.95);
    expect(mem!.effectiveN).toBeCloseTo(15, 6);
    expect(mem!.standaloneAccuracy).toBeCloseTo(11 / 15, 6);
    expect(mem!.wilson!.lower).toBeCloseTo(expected.lower, 10);
    expect(mem!.wilson!.upper).toBeCloseTo(expected.upper, 10);
  });

  it('applies the domain half-life, decaying an old sample below the trust bar', async () => {
    const key = newAgent();
    const old = new Date(T.getTime() - 2 * HALFLIFE_DAYS.perp * DAY_MS); // two perp half-lives
    for (let i = 0; i < 12; i++) await resolve([{ agent: key, agentVersion: 1, score: 0.5 }], 1, old);

    const atClose = await agentMemoryAsOf(db, 'perp', key, 1, old);
    expect(atClose!.effectiveN).toBeCloseTo(12, 6);
    expect(atClose!.evidence).toBe('SUFFICIENT');

    const later = await agentMemoryAsOf(db, 'perp', key, 1, T);
    expect(later!.effectiveN).toBeCloseTo(12 * recencyWeight(2 * HALFLIFE_DAYS.perp, HALFLIFE_DAYS.perp), 6);
    expect(later!.evidence).toBe('INSUFFICIENT'); // 3.0 effective — decayed below 10
  });

  it('POINT-IN-TIME: occurrences closing after asOf are invisible', async () => {
    const key = newAgent();
    const asOf = new Date(T.getTime() - 10 * DAY_MS);
    for (let i = 0; i < 3; i++) await resolve([{ agent: key, agentVersion: 1, score: 0.5 }], 1, new Date(asOf.getTime() - DAY_MS));
    for (let i = 0; i < 20; i++) await resolve([{ agent: key, agentVersion: 1, score: 0.5 }], -1, T);

    const at = await agentMemoryAsOf(db, 'perp', key, 1, asOf);
    expect(at!.occurrenceCount).toBe(3);
    expect(at!.standaloneAccuracy).toBe(1);

    const after = await agentMemoryAsOf(db, 'perp', key, 1, T);
    expect(after!.occurrenceCount).toBe(23);
    expect(after!.standaloneAccuracy!).toBeLessThan(0.5);
  });

  it('reads through the Brain facade, and never rolls up across versions', async () => {
    const key = newAgent();
    for (let i = 0; i < 11; i++) await resolve([{ agent: key, agentVersion: 3, score: 0.5 }], 1);
    const brain = createBrain(db, 'perp');
    const mem = await brain.agent(key, 3, T);
    expect(mem!.standaloneAccuracy).toBe(1);
    // A different version is a different track record, not a slice of the same one.
    expect(await brain.agent(key, 4, T)).toBeNull();
    // The facade exposes no aggregate-across-versions accessor at all.
    expect(Object.keys(brain)).not.toContain('agentAllVersions');
  });

  it('persistAgentMemory caches the aggregate without becoming the read path', async () => {
    const key = newAgent();
    for (let i = 0; i < 11; i++) await resolve([{ agent: key, agentVersion: 1, score: 0.5 }], 1);
    const mem = await persistAgentMemory(db, 'perp', key, 1, T);
    expect(mem!.evidence).toBe('SUFFICIENT');

    const rows = await db.select().from(brainAgentMemory).where(inArray(brainAgentMemory.agentKey, [key]));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.standaloneAccuracy)).toBeCloseTo(1, 6);
    expect(rows[0]!.evidence).toBe('SUFFICIENT');
    // The Risk-Agent veto columns stay null until M7 supplies shadow predictions.
    expect(rows[0]!.vetoedCount).toBeNull();
    expect(rows[0]!.vetoedWouldHaveLost).toBeNull();
  });

  it('has NO code path to ScoringConfig — descriptive, not prescriptive (§16)', async () => {
    // §16: Agent Memory "doesn't change any weight by itself." Weight changes belong to §24's
    // backtest-guarded hypothesis pipeline at M7. Asserted structurally rather than trusted:
    // comments are stripped first, so the module's own explanation of this rule does not
    // satisfy (or trip) the check.
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./agent-memory.ts', import.meta.url), 'utf8'));
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/ScoringConfig|agentWeights/);
    expect(code).not.toMatch(/@tip\/trading-agents/);
  });
});
