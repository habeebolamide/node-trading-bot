/**
 * Hierarchical backoff ladder (Part II §8) — the read-side staircase that answers "how similar
 * is close enough."
 *
 * §8 resolved this as discretized hash + hierarchical shrinkage and EXPLICITLY REJECTED both
 * k-NN and a separate weighted-similarity-score system ("functionally the same complexity as
 * the k-NN option already rejected, just dressed as a score instead of a distance metric").
 * Backoff is the only similarity mechanism. Do not add another.
 *
 * The ladder walks: exact fingerprint → drop the least-informative dimension → drop the next →
 * … → global base rate, stopping at the first rung whose effective-n clears the trust bar.
 *
 * AMBIGUITY RESOLVED (m5-historical-edge design.md, flagged for sign-off): §8 says "drop the
 * least-informative feature" without defining which that is. Resolved as ASCENDING COMPOSITE
 * WEIGHT (Part II §9 / Part III §3), alphabetical tiebreak — the plan already ranks these
 * dimensions by how much they matter, so reusing that ranking avoids inventing a second,
 * unvalidated informativeness ordering.
 */
import { dimensionsFor, setupFingerprint, type Dimension, type Domain, type FeatureTuple } from './fingerprint.js';

/**
 * Composite weights, verbatim from the plan's weight tables. These drive the drop ORDER only —
 * the Signal Engine reads its own weights from the TradingAgent's ScoringConfig, not from here.
 */
const MEMECOIN_WEIGHTS: Record<string, number> = {
  // Part II §9 Opportunity Score
  smart_money: 0.25,
  convergence: 0.2,
  momentum: 0.15,
  token_quality: 0.1,
  market_regime: 0.05,
};

const PERP_WEIGHTS: Record<string, number> = {
  // Part III §3 Signal Scoring Engine
  momentum: 0.2,
  open_interest: 0.2,
  market_regime: 0.15,
  liquidation: 0.15,
  funding: 0.1,
  positioning: 0.1,
  volume: 0.05,
  // `volatility` is the dimension m5-brain-core ADDED to reach the stated 6,561-cell count; the
  // plan's weight table does not rank it. Weight 0 therefore drops it FIRST, so the ladder
  // degrades toward exactly the plan-specified 7-feature set before it starts surrendering
  // dimensions the plan actually weighted.
  volatility: 0,
};

function weightsFor(domain: Domain): Record<string, number> {
  return domain === 'memecoin' ? MEMECOIN_WEIGHTS : PERP_WEIGHTS;
}

/** Least-informative first: ascending composite weight, alphabetical tiebreak for determinism. */
export function dropOrder(domain: Domain): readonly Dimension[] {
  const w = weightsFor(domain);
  return [...dimensionsFor(domain)].sort((a, b) => {
    const d = (w[a] ?? 0) - (w[b] ?? 0);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

/** Reserved setupId for a domain's global base rate — one more row on the ladder, not a special case. */
export function globalSetupId(domain: Domain): string {
  return `__global__:${domain}`;
}

export interface Rung {
  /** 0 = exact fingerprint; the last rung is the global base rate. */
  readonly depth: number;
  readonly setupId: string;
  /** Dimensions still in the hash at this rung; empty at the global rung. */
  readonly retained: readonly Dimension[];
  /** Human-readable description of what this rung is, surfaced in the read result. */
  readonly label: string;
}

/**
 * The full ladder for one feature snapshot: 6 rungs for memecoin (5 dims + global), 9 for perp
 * (8 dims + global). Every rung is materialized on write, so a read is a keyed lookup per rung
 * rather than an on-demand aggregation (see `recordSetupOutcome`).
 */
export function ladder(domain: Domain, features: FeatureTuple): readonly Rung[] {
  const order = dropOrder(domain);
  const all = dimensionsFor(domain);
  const rungs: Rung[] = [];

  // Rung 0 keeps everything; each subsequent rung drops one more from the least-informative end.
  for (let dropped = 0; dropped < all.length; dropped++) {
    const gone = order.slice(0, dropped);
    const retained = all.filter((d) => !gone.includes(d));
    rungs.push({
      depth: dropped,
      setupId: setupFingerprint(domain, features, retained),
      retained,
      label: dropped === 0 ? 'exact fingerprint' : `dropped ${gone.join(', ')}`,
    });
  }

  rungs.push({
    depth: all.length,
    setupId: globalSetupId(domain),
    retained: [],
    label: 'global base rate',
  });

  return rungs;
}
