/**
 * Agent Memory (§16) — each Analysis Agent's STANDALONE COUNTERFACTUAL ACCURACY.
 *
 * §16 pins down the mechanism precisely, because without one "how useful has this agent been"
 * collapses into Attribution (§22) or hypothesis promotion (§24) and adds nothing:
 *
 *   > if a hypothetical TradingAgent had followed *only* this one agent's lean,
 *   > direction-for-direction, ignoring every other agent, what would its win rate have been?
 *
 * DESCRIPTIVE, NOT PRESCRIPTIVE. §16: it "doesn't change any weight by itself." This module has
 * NO import of, and no code path to, `ScoringConfig` — weight changes go through §24's
 * backtest-guarded hypothesis pipeline at M7, at a different call site with a HIGHER bar
 * (effective-n ≥ 20, not this module's 10 — §41's implementer note says not to conflate them).
 *
 * All statistics come from the same shared helpers as Setup Memory. §41's "both domains call the
 * same function" instruction generalizes to "every memory calls the same function" — a second
 * decay implementation here would be exactly the drift §41 exists to prevent.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import { brainAgentMemory, brainAgentOccurrence, type Db } from '@tip/database';
import type { Domain } from './fingerprint.js';
import { HALFLIFE_DAYS, TRUST_THRESHOLD_EFFECTIVE_N, type Evidence } from './setup-memory.js';
import { recencyWeight, wilsonInterval } from './stats.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Agents excluded from counterfactual scoring entirely — a veto has no direction. */
export const NON_DIRECTIONAL_AGENTS: readonly string[] = [
  'memecoin.token_risk', // §40.13 hard veto
  'risk',                // §40.12 post-aggregation veto — separate metric, see below
];

/**
 * Agents whose score is bounded [0, +1] and can never express a bearish opinion. A score of 0
 * from these is SILENCE, not a SHORT lean — scoring it as bearish would manufacture a track
 * record out of nothing, and since memecoin is spot/long-only (§18) there is no short such a
 * "lean" could even have expressed.
 */
export const LONG_ONLY_AGENTS: readonly string[] = [
  'memecoin.smart_money',
  'memecoin.convergence',
  'memecoin.momentum',
  'memecoin.token_quality',
];

export interface AgentContribution {
  readonly agent: string;
  readonly agentVersion: number;
  /** The agent's own signed score, as stored on `signal_feature` at M4. */
  readonly score: number;
}

/**
 * The agent's own lean: +1, −1, or null for "no opinion" (not counted either way).
 *
 * Market Regime emits an enum plus a directional bias, and §7 is explicit that "its Agent Memory
 * tracks the bias, not the enum" — the bias IS the `score` on its AgentOutput, so it needs no
 * special case here beyond not being excluded.
 */
export function agentLean(c: AgentContribution): 1 | -1 | null {
  if (NON_DIRECTIONAL_AGENTS.includes(c.agent)) return null;
  if (c.score === 0) return null;
  if (LONG_ONLY_AGENTS.includes(c.agent) && c.score < 0) return null; // cannot happen; defensive
  return c.score > 0 ? 1 : -1;
}

export interface ResolvedPrediction {
  readonly predictionId: string;
  readonly domain: Domain;
  readonly closedAt: Date;
  /**
   * Which direction actually paid over the prediction's horizon: +1 if a LONG would have won,
   * −1 if a SHORT would have. NOT "did the composite win" — an agent that dissented from a
   * losing composite must be credited, which is the entire point of §16's mechanism.
   */
  readonly realizedDirection: 1 | -1;
}

/**
 * Record one resolved prediction against every contributing agent's counterfactual.
 *
 * Idempotent by DB constraint (rule 12): `unique(prediction_id, agent_key, agent_version)`.
 * M6's outcome-resolution handler is the call site.
 */
export async function recordAgentOutcome(
  db: Db,
  prediction: ResolvedPrediction,
  contributions: readonly AgentContribution[],
): Promise<number> {
  const rows = contributions
    .map((c) => ({ c, lean: agentLean(c) }))
    .filter((x): x is { c: AgentContribution; lean: 1 | -1 } => x.lean !== null)
    .map(({ c, lean }) => ({
      id: randomUUID(),
      domain: prediction.domain,
      agentKey: c.agent,
      agentVersion: c.agentVersion,
      predictionId: prediction.predictionId,
      closedAt: prediction.closedAt,
      lean,
      won: lean === prediction.realizedDirection,
    }));

  if (rows.length === 0) return 0;
  await db.insert(brainAgentOccurrence).values(rows).onConflictDoNothing();
  return rows.length;
}

export interface AgentMemory {
  readonly domain: Domain;
  readonly agentKey: string;
  readonly agentVersion: number;
  readonly standaloneAccuracy: number | null;
  readonly effectiveN: number;
  readonly wilson: { lower: number; upper: number } | null;
  readonly evidence: Evidence;
  readonly occurrenceCount: number;
  readonly sampleSince: Date | null;
}

/**
 * Recompute one agent's standalone accuracy as of `asOf`. Point-in-time like every Brain read.
 *
 * Returns null — distinct from INSUFFICIENT — when the agent has no occurrences at all.
 * "We have nothing" and "we have some and it isn't enough" are different answers and a caller
 * should be able to tell them apart.
 */
export async function agentMemoryAsOf(
  db: Db,
  domain: Domain,
  agentKey: string,
  agentVersion: number,
  asOf: Date,
): Promise<AgentMemory | null> {
  const rows = await db
    .select({ closedAt: brainAgentOccurrence.closedAt, won: brainAgentOccurrence.won })
    .from(brainAgentOccurrence)
    .where(and(
      eq(brainAgentOccurrence.domain, domain),
      eq(brainAgentOccurrence.agentKey, agentKey),
      // Versions never blend — this equality is load-bearing, not incidental.
      eq(brainAgentOccurrence.agentVersion, agentVersion),
      lte(brainAgentOccurrence.closedAt, asOf),
    ));

  if (rows.length === 0) return null;

  const halflifeDays = HALFLIFE_DAYS[domain];
  let effectiveN = 0;
  let effectiveWins = 0;
  let sampleSince: Date | null = null;
  for (const r of rows) {
    const weight = recencyWeight((asOf.getTime() - r.closedAt.getTime()) / DAY_MS, halflifeDays);
    effectiveN += weight;
    if (r.won) effectiveWins += weight;
    if (!sampleSince || r.closedAt < sampleSince) sampleSince = r.closedAt;
  }

  const sufficient = effectiveN >= TRUST_THRESHOLD_EFFECTIVE_N;
  const ci = sufficient ? wilsonInterval(effectiveWins, effectiveN, 0.95) : null;

  return {
    domain,
    agentKey,
    agentVersion,
    standaloneAccuracy: effectiveN > 0 ? effectiveWins / effectiveN : null,
    effectiveN,
    wilson: ci ? { lower: ci.lower, upper: ci.upper } : null,
    evidence: sufficient ? 'SUFFICIENT' : 'INSUFFICIENT',
    occurrenceCount: rows.length,
    sampleSince,
  };
}

/** Refresh the cached aggregate row. Live path only — reads recompute from occurrences. */
export async function persistAgentMemory(
  db: Db,
  domain: Domain,
  agentKey: string,
  agentVersion: number,
  asOf: Date,
): Promise<AgentMemory | null> {
  const mem = await agentMemoryAsOf(db, domain, agentKey, agentVersion, asOf);
  if (!mem) return null;

  const set = {
    standaloneAccuracy: mem.standaloneAccuracy === null ? null : String(mem.standaloneAccuracy),
    effectiveN: String(mem.effectiveN),
    effectiveWins: String(mem.effectiveN * (mem.standaloneAccuracy ?? 0)),
    wilsonLower: mem.wilson ? String(mem.wilson.lower) : null,
    wilsonUpper: mem.wilson ? String(mem.wilson.upper) : null,
    evidence: mem.evidence,
    occurrenceCount: mem.occurrenceCount,
    sampleSince: mem.sampleSince,
    updatedAt: asOf,
  };
  await db
    .insert(brainAgentMemory)
    .values({ id: randomUUID(), domain, agentKey, agentVersion, ...set })
    .onConflictDoUpdate({
      target: [brainAgentMemory.domain, brainAgentMemory.agentKey, brainAgentMemory.agentVersion],
      set,
    });
  return mem;
}
