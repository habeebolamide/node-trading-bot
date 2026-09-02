/**
 * @tip/planner — signal → TradeSetup (§35, Part III §4, Part II §10).
 *
 * Consumes a finished Signal; never re-derives one. Deterministic over the as-of view it reads,
 * so change 6 (Brain Seeding) replays it identically. NO_TRADE is a returned result, not a
 * throw — a directionally-correct signal that fails the R:R gate is a normal outcome.
 */
export * from './atr.js';
export * from './horizons.js';
export * from './memecoin.js';
export * from './perp.js';
export * from './plan.js';
export * from './sizing.js';
export * from './structure.js';
export * from './types.js';
export * from './correlation.js';
