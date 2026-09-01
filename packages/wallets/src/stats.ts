/**
 * Small statistical helpers for wallet scoring (pure). Beta-Binomial shrinkage keeps thin samples
 * from outranking deep ones (Task 6); percentile-rank is the [0,100] normalization the composite
 * uses across the wallet universe (§4).
 */

/**
 * Beta-Binomial shrunk rate (Task 6): `(wins + α₀) / (n + α₀ + β₀)`. With n=0 this returns the
 * prior mean `α₀/(α₀+β₀)` (the universe base rate), so an unproven wallet sits at the base rate,
 * not at 0 or 100%. 2-for-2 lands near the prior; 350-of-500 nearly at its raw rate.
 */
export function betaBinomialShrunk(wins: number, n: number, priorAlpha: number, priorBeta: number): number {
  return (wins + priorAlpha) / (n + priorAlpha + priorBeta);
}

/** Percentile rank of `value` within `population` in [0,100]: share of values ≤ value. */
export function percentileRank(value: number, population: readonly number[]): number {
  if (population.length === 0) return 50; // no universe → neutral
  const le = population.reduce((c, v) => c + (v <= value ? 1 : 0), 0);
  return (le / population.length) * 100;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
