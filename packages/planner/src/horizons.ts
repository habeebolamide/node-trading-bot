/**
 * Style → planning horizon (§8, m6-trade-planner design.md).
 *
 * AMBIGUITY RESOLVED: §8 offers three horizons per style but the R:R gate needs one TP. Chosen:
 * the MIDDLE horizon, reusing §8's own "middle of each band" rule already used for Primary TF.
 * The Outcome Engine (change 4) still measures all three plus the 1h cross-style reference.
 */
import type { Domain, TradingStyle } from '@tip/trading-agents';
import type { Horizon } from './types.js';

/** Milliseconds — used by the Paper Engine for HORIZON EXPIRY (Part II §10 exit precedence). */
export const HORIZON_MS: Record<Horizon, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  EOD: 8 * 60 * 60_000, // conservative — actual EOD anchoring lives in the outcome engine
  '1d': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

/** The middle of §8's style triad. Perp and memecoin share the same style→horizon mapping. */
const MIDDLE: Record<TradingStyle, Horizon> = {
  scalp: '15m',
  day: '4h',
  swing: '3d',
};

export function planningHorizon(style: TradingStyle, _domain: Domain): Horizon {
  return MIDDLE[style];
}
