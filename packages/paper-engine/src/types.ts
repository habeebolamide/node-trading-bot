/**
 * Types shared across the paper engine. `LadderRungConfig` matches `ScoringConfig.profitLadder`
 * from `@tip/trading-agents` — kept as a local shape so this module doesn't take a hard type
 * dependency on the config schema for one field.
 */
export interface LadderRungConfig {
  /** Price multiple of fill (e.g. 2.0 = 2× entry). */
  at: number;
  /** Fraction of the ORIGINAL entry notional to sell at this rung. Cumulative ≤ 1.0. */
  sellFraction: number;
  /**
   * Optional stop adjustment after this rung fires:
   *   null / undefined  → keep prior stop
   *   'move_stop_to_breakeven'
   *   { trail_stop_pct: X } — trails price by X% (up only, never down)
   */
  postTakeAction?: 'move_stop_to_breakeven' | { trail_stop_pct: number } | null;
}
