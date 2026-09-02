/**
 * Brain statistics — the shared numeric core (§41, Task 6).
 *
 * §41 exists because this math is fiddly and easy to get subtly wrong; its named failure mode
 * is applying recency decay to `wins` but not to `n` (or vice versa), which corrupts the Wilson
 * interval silently — the point estimate looks fine, the bounds are nonsense, and nothing
 * surfaces the bug until Setup Memory recommendations start looking inexplicably confident.
 *
 * EVERY Brain memory calls these functions. Do not fork per domain or per memory type: §41's
 * instruction is "both domains call the same function... a bug in one is a bug in both, which
 * is easier to catch than two subtly different bugs."
 */
import { ValidationError } from '@tip/domain';

/**
 * z for a two-sided confidence level. Lookup rather than an inverse-normal CDF — §41 keeps the
 * table small deliberately and throws on anything else rather than silently approximating.
 */
export function confidenceToZ(confidence: number): number {
  const table: Record<string, number> = {
    '0.90': 1.6449,
    '0.95': 1.9600,
    '0.99': 2.5758,
  };
  const key = confidence.toFixed(2);
  const z = table[key];
  if (z === undefined) {
    throw new ValidationError(
      `Uncommon confidence level ${confidence}; extend the lookup or use an inverse-normal CDF`,
    );
  }
  return z;
}

export interface WilsonInterval {
  readonly lower: number;
  readonly upper: number;
  readonly center: number;
}

/**
 * Wilson score interval — well-behaved at small n and near 0/1, unlike the naive normal
 * approximation (Part II §8).
 *
 * Takes EFFECTIVE (recency-weighted, fractional) counts, not raw integer ones. Wilson's
 * derivation does not require integer counts, so fractional n is mathematically valid — this is
 * exactly what Part II §8 mandates when it says "Wilson's `n` and win count must both be the
 * recency-weighted effective values." Feeding it raw counts while the win rate comes from
 * weighted contributions silently understates uncertainty.
 */
export function wilsonInterval(
  effectiveWins: number,
  effectiveN: number,
  confidence = 0.95,
): WilsonInterval {
  if (effectiveN <= 0) {
    return { lower: 0, upper: 1, center: 0.5 };
  }

  const z = confidenceToZ(confidence);
  const p = effectiveWins / effectiveN;
  const z2 = z * z;

  const denominator = 1 + z2 / effectiveN;
  const center = (p + z2 / (2 * effectiveN)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p) + z2 / (4 * effectiveN)) / effectiveN)) / denominator;

  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    center,
  };
}

/**
 * Exponential recency weight (Task 6): `0.5 ^ (age / halflife)`. An occurrence exactly one
 * half-life old contributes exactly 0.5. Never negative-age-clamped — a future-dated occurrence
 * is a caller bug (look-ahead, rule 21) and should surface as a weight > 1, not be silently
 * normalized away.
 */
export function recencyWeight(ageDays: number, halflifeDays: number): number {
  if (halflifeDays <= 0) throw new ValidationError(`halflifeDays must be > 0, got ${halflifeDays}`);
  return Math.pow(0.5, ageDays / halflifeDays);
}

export interface WeightedItem {
  readonly value: number;
  readonly weight: number;
}

/**
 * Weighted median (§41) — the value at which cumulative weight crosses half the total.
 * Null on an empty sample or when every weight has decayed to zero.
 */
export function weightedMedian(items: readonly WeightedItem[]): number | null {
  if (items.length === 0) return null;

  const sorted = [...items].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, x) => sum + x.weight, 0);
  if (totalWeight === 0) return null;

  const half = totalWeight / 2;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= half) return item.value;
  }
  return sorted[sorted.length - 1]!.value;
}
