/**
 * Setup fingerprinting (Part II §8, rule 24) — the discretized hash that keys Setup Memory.
 *
 * NOT to be confused with `signalFingerprint` in `@tip/trading-agents`, which is the §9 signal
 * DEDUP hash over `(tradingAgentId, symbol, direction, tfCloseMinute)`. This one hashes the
 * BUCKETED FEATURE TUPLE and answers "what kind of setup is this?" — two different questions,
 * two different hashes, deliberately named differently.
 *
 * Rule 24: `setupId` is computed from the domain's FULL feature set, never a TradingAgent's
 * enabled-agent subset. Two TradingAgents with different weights looking at the same market
 * state must land on the same cell, or Setup Memory fragments per-agent and stops being a
 * shared Brain fact (§15).
 *
 * Part II §8 resolved the method as discretized hash + hierarchical shrinkage, explicitly
 * rejecting k-NN and weighted-similarity scoring. Backoff (m5-historical-edge) is the only
 * similarity mechanism.
 */
import { createHash } from 'node:crypto';
import { ValidationError } from '@tip/domain';

export type Domain = 'perp' | 'memecoin';
export type Bucket = 'LOW' | 'MED' | 'HIGH';

/**
 * Memecoin tuple — 5 dimensions → 3⁵ = 243 cells (Part II §8, named explicitly there).
 * Early-Entry Edge, Signal Freshness and Historical Edge stay in the Opportunity Score
 * composite (Part II §9) but are dropped from the fingerprint: §8's stated reason is that 243
 * cells with an effective-n ≥ 10 floor is reachable given one position at a time (§32) and a
 * 30-day half-life, where ~6,500 cells is not.
 */
export const MEMECOIN_DIMENSIONS = [
  'smart_money',
  'convergence',
  'momentum',
  'token_quality',
  'market_regime',
] as const;

/**
 * Perp tuple — 8 dimensions → 3⁸ = 6,561 cells.
 *
 * AMBIGUITY RESOLVED (m5-brain-core design.md, flagged for sign-off): Part II §8 says only
 * "Perp keeps its full tuple," and Part III §3's weight table has 8 rows — but one of them is
 * Historical Edge, which IS the Setup Memory read (§40.16). Fingerprinting on it would require
 * the answer to compute the key. Resolved as the 7 non-circular composite inputs plus
 * Volatility (ATR ratio) as its own dimension: it hits the 6,561 ≈ "6,500 for perp" cell count
 * CLAUDE.md's mandatory-test list states (7 dimensions would give 2,187 and miss it), and
 * volatility is already a first-class separately-named axis in the plan — Market Regime (§40.3)
 * computes an ATR ratio and can emit HIGH_VOL, and the Risk Agent (§40.12) checks "volatility
 * extremity" as a check distinct from regime.
 */
export const PERP_DIMENSIONS = [
  'momentum',
  'open_interest',
  'market_regime',
  'liquidation',
  'funding',
  'positioning',
  'volume',
  'volatility',
] as const;

export type MemecoinDimension = (typeof MEMECOIN_DIMENSIONS)[number];
export type PerpDimension = (typeof PERP_DIMENSIONS)[number];
export type Dimension = MemecoinDimension | PerpDimension;

export function dimensionsFor(domain: Domain): readonly Dimension[] {
  return domain === 'memecoin' ? MEMECOIN_DIMENSIONS : PERP_DIMENSIONS;
}

/**
 * Tertile bucketing at FIXED cut-points ∓1/3, not empirical tertiles of observed data.
 * Empirical cuts would make a fingerprint's meaning drift as the sample grows and would
 * silently re-bucket old occurrences; deterministic and replay-stable (rules 11/21) matters
 * more here than balanced cell occupancy. Boundary values land in MED.
 */
export function bucket(x: number): Bucket {
  if (!Number.isFinite(x)) throw new ValidationError(`bucket() needs a finite score, got ${x}`);
  if (x < -1 / 3) return 'LOW';
  if (x > 1 / 3) return 'HIGH';
  return 'MED';
}

/** Signed [-1,+1] score per dimension. Every dimension of the domain's tuple must be present. */
export type FeatureTuple = Readonly<Partial<Record<Dimension, number>>>;

/**
 * Hash the bucketed tuple. `retain` (used by the m5-historical-edge backoff ladder) narrows the
 * dimension set; the ARITY is encoded in the hashed string so a 2-dimension fingerprint can
 * never collide with a 5-dimension one whose other three happen to sit at MED.
 *
 * Deterministic and order-independent at the call site: dimensions are emitted in the canonical
 * order declared above, so a caller passing an object gets the same hash regardless of key
 * insertion order.
 */
export function setupFingerprint(
  domain: Domain,
  features: FeatureTuple,
  retain?: readonly Dimension[],
): string {
  const all = dimensionsFor(domain);
  const dims = retain ?? all;

  const parts: string[] = [];
  for (const d of all) {
    if (!dims.includes(d)) continue;
    const v = features[d];
    if (v === undefined) {
      // Rule 24 — never silently fingerprint a partial tuple. A missing dimension means the
      // caller assembled the snapshot wrong; a hash computed anyway would quietly alias into
      // a different cell and corrupt that cell's statistics.
      throw new ValidationError(`setupFingerprint(${domain}): missing dimension "${d}"`);
    }
    parts.push(`${d}:${bucket(v)}`);
  }

  const key = `${domain}|n=${parts.length}|${parts.join('|')}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32); // 128-bit hex prefix
}
