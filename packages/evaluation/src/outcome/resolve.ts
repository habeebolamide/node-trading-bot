/**
 * Outcome resolution (§21, Task 7). One prediction × one horizon → one row of numbers.
 *
 * ANCHORING (§21). Every horizon measures from T1 (fill), not T0 (signal creation). §21 is
 * explicit and it matters concretely: a LIMIT that sits `PENDING_ENTRY` for candles before
 * filling would silently eat into the reported horizon otherwise. T0 remains the reference for
 * no-look-ahead (rules 21/22) — that is a different clock for a different purpose.
 *
 * TIE-BREAK (§25). In `CANDLE_1M_CONSERVATIVE` mode, a bar whose range spans BOTH TP and SL is
 * resolved as SL first. §25's reasoning: "a Brain that slightly under-rates a seeded fingerprint
 * costs a missed trade, one that over-rates it costs a taken loss" — the correct direction to
 * be wrong in when the data cannot say. TICK mode knows the true order and uses it.
 */
export type ResolutionMode = 'TICK' | 'CANDLE_1M_CONSERVATIVE';

export interface ResolveInput {
  readonly entry: number;
  readonly stopLoss: number;
  readonly takeProfit: number | null;
  readonly direction: 'LONG' | 'SHORT';
  readonly t1: Date;
  readonly horizonEnd: Date;
  /** 1m bars used in `CANDLE_1M_CONSERVATIVE` mode — chronological, `openTime <= horizonEnd`. */
  readonly bars?: readonly {
    openTime: Date; closeTime: Date;
    open: number; high: number; low: number; close: number;
  }[];
  /** Explicit tick sequence for `TICK` mode. Optional; when absent the resolver falls back to
   *  the last bar close inside the horizon and marks the row TICK-shaped but without touches. */
  readonly ticks?: readonly { at: Date; price: number }[];
  readonly mode: ResolutionMode;
  /** Benchmark return over the same window, as a fraction. Perp: underlying b&h; memecoin: SOL. */
  readonly benchmarkReturnPct?: number;
}

export interface ResolveResult {
  readonly won: boolean;
  readonly hitTarget: boolean;
  readonly hitInvalidation: boolean;
  readonly closedAt: Date;
  /** Signed by direction: LONG return = (exit − entry) / entry; SHORT flips sign. */
  readonly returnPct: number;
  readonly benchmarkReturnPct: number | null;
  readonly alpha: number | null;
  /** MFE / MAE are signed by direction — MFE ≥ 0 favourable, MAE ≤ 0 adverse. */
  readonly mfe: number;
  readonly mae: number;
  readonly holdingPeriodSec: number;
  readonly outcomeResolution: ResolutionMode;
}

const directionSign = (d: 'LONG' | 'SHORT') => (d === 'LONG' ? 1 : -1);
const signedReturn = (entry: number, exit: number, d: 'LONG' | 'SHORT') => ((exit - entry) / entry) * directionSign(d);

/**
 * Extremes inside a bar signed by direction. LONG's favourable is the HIGH; SHORT's is the LOW.
 * Used for MFE/MAE and for the SL/TP crossing checks in candle mode.
 */
function favourablePrice(bar: { high: number; low: number }, d: 'LONG' | 'SHORT') {
  return d === 'LONG' ? bar.high : bar.low;
}
function adversePrice(bar: { high: number; low: number }, d: 'LONG' | 'SHORT') {
  return d === 'LONG' ? bar.low : bar.high;
}

/**
 * Did this bar's range CROSS a level in the trade's direction?
 * LONG: TP crossed if bar.high ≥ TP; SL crossed if bar.low ≤ SL.
 * SHORT: mirror.
 */
function crossedTP(bar: { high: number; low: number }, tp: number | null, d: 'LONG' | 'SHORT') {
  if (tp === null) return false;
  return d === 'LONG' ? bar.high >= tp : bar.low <= tp;
}
function crossedSL(bar: { high: number; low: number }, sl: number, d: 'LONG' | 'SHORT') {
  return d === 'LONG' ? bar.low <= sl : bar.high >= sl;
}

export function resolveOutcome(i: ResolveInput): ResolveResult {
  const anchor = i.t1;
  let mfe = 0;
  let mae = 0;

  const finalize = (exitPrice: number, hitTarget: boolean, hitInvalidation: boolean, closedAt: Date): ResolveResult => {
    const returnPct = signedReturn(i.entry, exitPrice, i.direction);
    const benchmarkReturnPct = i.benchmarkReturnPct ?? null;
    const alpha = benchmarkReturnPct === null ? null : returnPct - benchmarkReturnPct;
    // Won = hit TP before SL within the horizon (Task 7 verbatim).
    const won = hitTarget && !hitInvalidation;
    return {
      won, hitTarget, hitInvalidation, closedAt, returnPct, benchmarkReturnPct, alpha,
      mfe, mae,
      holdingPeriodSec: Math.max(0, Math.round((closedAt.getTime() - anchor.getTime()) / 1000)),
      outcomeResolution: i.mode,
    };
  };

  if (i.mode === 'TICK') {
    // Tick mode: scan the tick stream chronologically; whichever level is touched first decides.
    const ticks = (i.ticks ?? []).filter((t) => t.at.getTime() >= anchor.getTime() && t.at.getTime() <= i.horizonEnd.getTime());
    for (const t of ticks) {
      const ex = signedReturn(i.entry, t.price, i.direction);
      if (ex > mfe) mfe = ex;
      if (ex < mae) mae = ex;
      const slHit = i.direction === 'LONG' ? t.price <= i.stopLoss : t.price >= i.stopLoss;
      const tpHit = i.takeProfit !== null && (i.direction === 'LONG' ? t.price >= i.takeProfit : t.price <= i.takeProfit);
      if (slHit) return finalize(i.stopLoss, false, true, t.at);
      if (tpHit) return finalize(i.takeProfit!, true, false, t.at);
    }
    // Nothing touched → resolve at the last observed price if any, else at horizon end from entry.
    const last = ticks[ticks.length - 1];
    return finalize(last?.price ?? i.entry, false, false, last?.at ?? i.horizonEnd);
  }

  // CANDLE_1M_CONSERVATIVE — scan 1m bars from T1 forward. The whole methodological point is
  // the SL-first pessimistic tie-break on an ambiguous bar (§25).
  const bars = (i.bars ?? []).filter((b) => b.closeTime.getTime() > anchor.getTime() && b.openTime.getTime() < i.horizonEnd.getTime());
  for (const bar of bars) {
    const favExc = signedReturn(i.entry, favourablePrice(bar, i.direction), i.direction);
    const advExc = signedReturn(i.entry, adversePrice(bar, i.direction), i.direction);
    if (favExc > mfe) mfe = favExc;
    if (advExc < mae) mae = advExc;

    const tpCrossed = crossedTP(bar, i.takeProfit, i.direction);
    const slCrossed = crossedSL(bar, i.stopLoss, i.direction);

    // Ambiguous — both crossed in one bar. §25 pessimistic tie-break: SL FIRST.
    if (tpCrossed && slCrossed) {
      return finalize(i.stopLoss, false, true, bar.closeTime);
    }
    if (slCrossed) return finalize(i.stopLoss, false, true, bar.closeTime);
    if (tpCrossed) return finalize(i.takeProfit!, true, false, bar.closeTime);
  }

  // Neither touched inside the horizon → resolve at the last bar close ≤ horizonEnd, or at
  // horizon end from entry if we saw no bars.
  const last = bars[bars.length - 1];
  const exitPrice = last?.close ?? i.entry;
  const closedAt = last?.closeTime ?? i.horizonEnd;
  return finalize(exitPrice, false, false, closedAt);
}
