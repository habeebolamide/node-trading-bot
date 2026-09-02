/**
 * Horizon set (Task 7). Each style has THREE horizons plus a cross-style 1h reference; all four
 * are evaluated. The PLANNING horizon (the middle of the style's triad, per m6-trade-planner's
 * `planningHorizon`) is the one whose result is fed to the Brain — see design.md § "which horizon
 * defines `won` for the Brain": one prediction contributes exactly ONE occurrence per
 * fingerprint, or effective-n inflates 4× and every Wilson interval becomes a lie.
 */
import type { TradingStyle } from '@tip/trading-agents';

export type Horizon = '5m' | '15m' | '30m' | '1h' | '4h' | 'EOD' | '1d' | '3d' | '1w';

export const HORIZON_MS: Record<Horizon, number> = {
  '5m': 5 * 60_000, '15m': 15 * 60_000, '30m': 30 * 60_000,
  '1h': 60 * 60_000, '4h': 4 * 60 * 60_000,
  EOD: 8 * 60 * 60_000, // conservative — real EOD anchoring is a future refinement
  '1d': 24 * 60 * 60_000, '3d': 3 * 24 * 60 * 60_000, '1w': 7 * 24 * 60 * 60_000,
};

const STYLE_TRIAD: Record<TradingStyle, readonly [Horizon, Horizon, Horizon]> = {
  scalp: ['5m', '15m', '30m'],
  day:   ['1h', '4h', 'EOD'],
  swing: ['1d', '3d', '1w'],
};

/** The 3 style horizons plus 1h reference (Task 7 — deduped when the style already includes it). */
export function horizonSet(style: TradingStyle): readonly Horizon[] {
  const triad = STYLE_TRIAD[style];
  const out: Horizon[] = [...triad];
  if (!out.includes('1h')) out.push('1h');
  return out;
}

/** Middle of the triad (§8) — the planning horizon, the one the setup TARGETED. */
export function planningHorizonFor(style: TradingStyle): Horizon {
  return STYLE_TRIAD[style][1];
}
