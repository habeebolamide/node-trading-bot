/**
 * Token Memory (Part II §8 "Historical token/setup behavior", Part II §6 Token Intelligence).
 *
 * Task 6 fixes the inputs: liquidity / age / holder-concentration / volume, percentile-normalized.
 * SAFETY IS DELIBERATELY ABSENT — "safety is a separate hard gate (Token Risk veto), not a soft
 * score input" (Task 6). The Token Risk Agent (§40.13) built at M4 owns that and is untouched
 * here; blending a safety signal into a soft score is exactly how a rug ends up merely
 * low-scoring instead of vetoed.
 *
 * Holder concentration is INVERTED before normalizing — a high top-10 share is bad, and leaving
 * it uninverted would score the most rug-prone tokens highest.
 */
import { eq } from 'drizzle-orm';
import { brainTokenMemory, type Db } from '@tip/database';
import { wilsonInterval } from './stats.js';

/** Below this many observed peers there is no meaningful universe to percentile against. */
export const MIN_UNIVERSE_FOR_PERCENTILE = 10;

export interface TokenProfile {
  readonly liquidityUsd?: number;
  readonly ageMinutes?: number;
  readonly top10HolderPct?: number; // 0..1
  readonly volume24hUsd?: number;
}

export interface TokenOutcomes {
  readonly effectiveN: number;
  readonly winRate: number | null;
  readonly medianReturn: number | null;
  readonly wilsonLower: number | null;
  readonly wilsonUpper: number | null;
}

export interface TokenMemory {
  readonly mint: string;
  readonly profile: TokenProfile;
  /** Percentile-normalized composite in [0,1]; null when un-scoreable. */
  readonly score: number | null;
  readonly outcomes: TokenOutcomes | null;
  readonly evidence: 'SUFFICIENT' | 'INSUFFICIENT';
  readonly asOf: Date;
}

/** Fraction of `universe` values at or below `value`. Null when the universe is too thin. */
export function percentileOf(value: number, universe: readonly number[]): number | null {
  if (universe.length < MIN_UNIVERSE_FOR_PERCENTILE) return null;
  const atOrBelow = universe.filter((u) => u <= value).length;
  return atOrBelow / universe.length;
}

export interface TokenUniverse {
  readonly liquidityUsd: readonly number[];
  readonly ageMinutes: readonly number[];
  readonly top10HolderPct: readonly number[];
  readonly volume24hUsd: readonly number[];
}

/**
 * Equal-weighted mean of the percentiles that could actually be computed.
 *
 * Returns null rather than a partial score when NO sub-metric is available — a fabricated
 * percentile is worse than no score, and a caller can distinguish "unknown" from "bad" only if
 * we refuse to invent one. When some are available the score is the mean of those, which is the
 * same "score what you have, report coverage" discipline M2 used for forward returns.
 */
export function tokenScore(profile: TokenProfile, universe: TokenUniverse): number | null {
  const parts: number[] = [];

  if (profile.liquidityUsd !== undefined) {
    const p = percentileOf(profile.liquidityUsd, universe.liquidityUsd);
    if (p !== null) parts.push(p);
  }
  if (profile.ageMinutes !== undefined) {
    const p = percentileOf(profile.ageMinutes, universe.ageMinutes);
    if (p !== null) parts.push(p);
  }
  if (profile.top10HolderPct !== undefined) {
    // Inverted: concentration is a NEGATIVE. Percentile the negation so "less concentrated"
    // ranks high.
    const p = percentileOf(-profile.top10HolderPct, universe.top10HolderPct.map((x) => -x));
    if (p !== null) parts.push(p);
  }
  if (profile.volume24hUsd !== undefined) {
    const p = percentileOf(profile.volume24hUsd, universe.volume24hUsd);
    if (p !== null) parts.push(p);
  }

  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/** Outcome stats for a token, using the SAME Wilson helper as every other memory (§41). */
export function tokenOutcomes(effectiveWins: number, effectiveN: number, medianReturn: number | null): TokenOutcomes {
  if (effectiveN <= 0) {
    return { effectiveN: 0, winRate: null, medianReturn, wilsonLower: null, wilsonUpper: null };
  }
  const ci = wilsonInterval(effectiveWins, effectiveN, 0.95);
  return {
    effectiveN,
    winRate: effectiveWins / effectiveN,
    medianReturn,
    wilsonLower: ci.lower,
    wilsonUpper: ci.upper,
  };
}

/** Point-in-time read of the stored profile. `asOf` is required for interface uniformity. */
export async function tokenMemoryAsOf(db: Db, mint: string, asOf: Date): Promise<TokenMemory | null> {
  const rows = await db.select().from(brainTokenMemory).where(eq(brainTokenMemory.mint, mint)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    mint: r.mint,
    profile: (r.profile ?? {}) as TokenProfile,
    score: r.score === null ? null : Number(r.score),
    outcomes: (r.outcomes ?? null) as TokenOutcomes | null,
    evidence: r.evidence as 'SUFFICIENT' | 'INSUFFICIENT',
    asOf,
  };
}

export async function upsertTokenMemory(
  db: Db,
  input: { mint: string; profile: TokenProfile; score: number | null; outcomes: TokenOutcomes | null; asOf: Date },
): Promise<void> {
  const evidence = input.outcomes && input.outcomes.wilsonLower !== null ? 'SUFFICIENT' : 'INSUFFICIENT';
  const row = {
    mint: input.mint,
    domain: 'memecoin',
    profile: input.profile,
    score: input.score === null ? null : String(input.score),
    outcomes: input.outcomes,
    evidence,
    updatedAt: input.asOf,
  };
  await db.insert(brainTokenMemory).values(row).onConflictDoUpdate({ target: brainTokenMemory.mint, set: row });
}
