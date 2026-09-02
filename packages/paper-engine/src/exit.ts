/**
 * Exit engine (Part II §10). Five conditions evaluated in STRICT PRECEDENCE — precedence is not
 * a preference:
 *
 *   1. STOP LOSS      price ≤ current stop            [tick monitor]
 *      Above wallet-exit because a rug can outrun webhook latency.
 *   2. WALLET EXIT    accumulator ≥ walletExitThreshold [webhook pipeline]
 *      Thesis death — close everything, no moon-bag nobody is watching.
 *   3. PROFIT LADDER  next unfired rung crossed        [tick monitor]
 *      Partial close; may adjust stop.
 *   4. TAKE PROFIT    price ≥ fill × (1 + takeProfitPct) [tick monitor]
 *      Only when profitLadder is null (mutually exclusive per Part II §10).
 *   5. HORIZON EXPIRY style horizon elapsed            [scheduler]
 *
 * "Full close" (STOP LOSS / WALLET EXIT / TAKE PROFIT / HORIZON EXPIRY) means close 100% of what
 * is CURRENTLY HELD, not 100% of the original notional. Part II §10 demands this be explicit in
 * the engine code "to prevent negative-size fills" — that is why every full-close path routes
 * through `closeRemaining()` and every ladder path routes through `closeFraction()`. No call site
 * computes a size from the original entry.
 */
import type { LadderRungConfig } from './types.js';

export type ExitReason = 'STOP_LOSS' | 'WALLET_EXIT' | 'LADDER_RUNG' | 'TAKE_PROFIT' | 'HORIZON_EXPIRY' | 'LIMIT_EXPIRY';

export type ExitDecision =
  | { readonly kind: 'STOP_LOSS'; readonly price: number }
  | { readonly kind: 'WALLET_EXIT' }
  | { readonly kind: 'LADDER_RUNG'; readonly rungIndex: number; readonly rungPrice: number; readonly sellFraction: number; readonly postTakeAction: LadderRungConfig['postTakeAction'] | null }
  | { readonly kind: 'TAKE_PROFIT'; readonly price: number }
  | { readonly kind: 'HORIZON_EXPIRY' }
  /** m6-limit-orders-perp — PENDING_ENTRY-only. Return one of these OR NONE, never both. */
  | { readonly kind: 'ACTIVATE_LIMIT'; readonly fillPrice: number }
  | { readonly kind: 'EXPIRE_LIMIT' }
  | { readonly kind: 'NONE' };

export interface PositionState {
  entryPrice: number;
  currentStop: number;
  takeProfit: number | null;
  direction: 'LONG' | 'SHORT';
  /** Rung indices that have already fired (Part II §10: each rung fires at most once). */
  firedRungs: readonly number[];
  ladder: readonly LadderRungConfig[] | null;
}

export interface EvalTickInput extends PositionState {
  price: number;
  now: Date;
  horizonEndsAt: Date;
  walletExitReached: boolean;
}

/**
 * Decide the next exit action given a price observation, a wallet-exit signal, and the horizon.
 * Called by BOTH the tick monitor (per price observation) and the horizon scheduler (per elapsed
 * timer): the same precedence discipline everywhere means a stop + wallet exit + rung all
 * simultaneously true resolves the same way regardless of who noticed.
 *
 * Returns AT MOST one decision per call. The engine loops if multiple rungs were crossed in a
 * single price gap (see `crossedLadderRungs`).
 */
export function evalTick(i: EvalTickInput): ExitDecision {
  // 1. STOP LOSS — LONG: price ≤ stop; SHORT: price ≥ stop (memecoin is long-only so LONG dominates).
  const stopHit = i.direction === 'LONG' ? i.price <= i.currentStop : i.price >= i.currentStop;
  if (stopHit) return { kind: 'STOP_LOSS', price: i.price };

  // 2. WALLET EXIT — a rug via webhook still ranks below the price-feed stop (SL beats webhook),
  // but above every profit-taking path because if smart money has bailed, the thesis is dead.
  if (i.walletExitReached) return { kind: 'WALLET_EXIT' };

  // 3. PROFIT LADDER — fire the NEXT unfired rung whose price has been crossed. Callers handle a
  // gap-up that crosses several rungs by calling `crossedLadderRungs` and looping.
  if (i.ladder && i.ladder.length > 0 && i.direction === 'LONG') {
    for (let idx = 0; idx < i.ladder.length; idx++) {
      if (i.firedRungs.includes(idx)) continue;
      const rungPrice = i.entryPrice * i.ladder[idx]!.at;
      if (i.price >= rungPrice) {
        return {
          kind: 'LADDER_RUNG',
          rungIndex: idx,
          rungPrice,
          sellFraction: i.ladder[idx]!.sellFraction,
          postTakeAction: i.ladder[idx]!.postTakeAction ?? null,
        };
      }
      break; // rungs are ordered — if this one isn't crossed, later ones can't be either
    }
  }

  // 4. TAKE PROFIT — only when a ladder is not configured (Part II §10 mutual exclusion).
  if (!i.ladder && i.takeProfit !== null) {
    const tpHit = i.direction === 'LONG' ? i.price >= i.takeProfit : i.price <= i.takeProfit;
    if (tpHit) return { kind: 'TAKE_PROFIT', price: i.price };
  }

  // 5. HORIZON EXPIRY — the scheduler will normally deliver this via a fired timer, but a tick
  // observed after the horizon end is also a legitimate close trigger.
  if (i.now >= i.horizonEndsAt) return { kind: 'HORIZON_EXPIRY' };

  return { kind: 'NONE' };
}

/**
 * All ladder rungs crossed at `price` and not yet fired, in order. A gap-up hits every rung it
 * passed, in ascending order, at the crossing price — Part II §10 tie-break: "gap-up fires only
 * the rungs actually crossed, in order, at the crossing prices — not all rungs at the final
 * price." Caller loops evalTick for each entry.
 */
export function crossedLadderRungs(
  entryPrice: number,
  price: number,
  ladder: readonly LadderRungConfig[],
  firedRungs: readonly number[],
): number[] {
  const out: number[] = [];
  for (let idx = 0; idx < ladder.length; idx++) {
    if (firedRungs.includes(idx)) continue;
    if (price >= entryPrice * ladder[idx]!.at) out.push(idx);
  }
  return out;
}

/**
 * Wallet-exit accumulator (Part II §10). `Σ (1 − currentHeldFraction) × entryWeight` — cluster
 * weight sold across the position's originating wallets. Partial sells contribute proportionally;
 * the cluster dedup (§5) is already baked into `entryWeight`, so one funder dumping through five
 * addresses shows up as one exit, not five.
 */
export function walletExitAccumulator(rows: readonly { currentHeldFraction: number; entryWeight: number }[]): number {
  return rows.reduce((sum, r) => sum + (1 - r.currentHeldFraction) * r.entryWeight, 0);
}

/**
 * `postTakeAction` handlers:
 *  - `null` / undefined  → keep prior stop
 *  - `move_stop_to_breakeven` → raise stop to entry price
 *  - `trail_stop_pct: X` → stop trails price by X% (FOLLOWS UP, NEVER DOWN — Part II §10)
 */
export function applyPostTakeAction(input: {
  entryPrice: number;
  currentStop: number;
  currentPrice: number;
  action: LadderRungConfig['postTakeAction'] | null | undefined;
}): number {
  const a = input.action;
  if (a === null || a === undefined) return input.currentStop;
  if (a === 'move_stop_to_breakeven') return Math.max(input.currentStop, input.entryPrice);
  if (typeof a === 'object' && 'trail_stop_pct' in a) {
    const trailed = input.currentPrice * (1 - a.trail_stop_pct);
    return Math.max(input.currentStop, trailed);
  }
  return input.currentStop;
}


/**
 * PENDING_ENTRY tick evaluator (m6-limit-orders-perp). Two questions:
 *   1. Has the limit filled? LONG: `price ≤ limit`; SHORT: `price ≥ limit`.
 *   2. Has the LIMIT expiry window elapsed?
 *
 * SL/TP/ladder never fire on a pending position — there's nothing to close yet. Kept as a
 * separate function so the main `evalTick` can stay LONG/SHORT-agnostic about state.
 */
export interface EvalPendingInput {
  direction: 'LONG' | 'SHORT';
  limitPrice: number;
  price: number;
  now: Date;
  expiresAt: Date;
}
export function evalPendingTick(i: EvalPendingInput): ExitDecision {
  // Expiry check first — a bar that both fills AND expires resolves as FILL (fill takes
  // precedence because it happened during the valid window). But an unambiguous expiry with
  // no crossing is the common case; this ordering only matters for the pathological both-true.
  const filled = i.direction === 'LONG' ? i.price <= i.limitPrice : i.price >= i.limitPrice;
  if (filled) return { kind: 'ACTIVATE_LIMIT', fillPrice: i.limitPrice };
  if (i.now >= i.expiresAt) return { kind: 'EXPIRE_LIMIT' };
  return { kind: 'NONE' };
}
