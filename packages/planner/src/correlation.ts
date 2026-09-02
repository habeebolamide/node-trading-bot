/**
 * maxCorrelatedExposure gate (§37 "Portfolio-level risk", §2114 computation — audit #14).
 *
 * §2114 verbatim: "Rolling Pearson correlation of returns over 30 primary candles between the
 * candidate symbol and each currently-held symbol; if correlation ≥ 0.7 the candidate's notional
 * joins a 'correlated bucket' whose total is capped at 1× a single full-risk position. Enforced
 * at the Trade Planner / Risk gate."
 *
 * Interpretation notes (flagged per CLAUDE.md ambiguity rule):
 *  • "1× a single full-risk position" — the yardstick used is the CANDIDATE's own sized
 *    notional (it was just sized at full risk by §35), scaled by `maxCorrelatedExposure`
 *    (default 1). Holding one full-risk position in a ≥0.7-correlated symbol and adding
 *    another therefore trips the cap — the §2333 "3 positions that are functionally one
 *    oversized bet" failure this gate exists to stop.
 *  • Correlation is SIGNED ≥ threshold: a strongly negatively-correlated holding is a hedge,
 *    not the same bet, and does not join the bucket.
 *  • Insufficient overlapping history (< MIN_RETURN_POINTS returns) counts the holding as
 *    correlated — pessimistic on purpose: for the BTC/ETH/SOL universe the prior is high
 *    correlation, and the gate's failure mode must be a refused trade, never silent
 *    over-exposure.
 *
 * Rarely binds while one-symbol-per-agent + maxConcurrentPositions=1 hold (the plan says as
 * much) — it exists for when either is raised.
 */
import type { MarketSymbol, Timeframe } from '@tip/domain';

export const CORRELATION_THRESHOLD = 0.7;
export const CORRELATION_LOOKBACK_CANDLES = 30; // 30 returns → 31 closes
export const MIN_RETURN_POINTS = 10;

/** Pearson correlation of two equal-length series. 0 when degenerate (flat series / n<2). */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sa = 0; let sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]!; sb += b[i]!; }
  const ma = sa / n; const mb = sb / n;
  let cov = 0; let va = 0; let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma; const db = b[i]! - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/** Simple returns from a close series (length n → n−1 returns). Non-positive closes are skipped. */
export function returnsFromCloses(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    if (prev > 0 && cur > 0) out.push(cur / prev - 1);
  }
  return out;
}

export interface HeldPosition { symbol: string; notional: number }

export interface CorrelatedExposureInput {
  candidateSymbol: string;
  candidateNotional: number;
  heldPositions: readonly HeldPosition[];
  /** Bucket cap as a multiple of the candidate's full-risk notional. Config default 1. */
  maxCorrelatedExposure: number;
  /** candle-close reader bound to the plan's as-of time (rules 21/22 — never wall clock). */
  closesAsOf: (symbol: MarketSymbol, timeframe: Timeframe, limit: number) => Promise<number[]>;
  timeframe: Timeframe;
  threshold?: number;
}

export type CorrelatedExposureResult =
  | { ok: true; bucketNotional: number; correlated: readonly { symbol: string; correlation: number | null }[] }
  | { ok: false; bucketNotional: number; cap: number; correlated: readonly { symbol: string; correlation: number | null }[] };

/**
 * The gate. `correlation: null` in the result marks a holding bucketed pessimistically for
 * lack of overlapping history rather than by a measured coefficient.
 */
export async function evaluateCorrelatedExposure(i: CorrelatedExposureInput): Promise<CorrelatedExposureResult> {
  const threshold = i.threshold ?? CORRELATION_THRESHOLD;
  const candidateCloses = await i.closesAsOf(i.candidateSymbol as MarketSymbol, i.timeframe, CORRELATION_LOOKBACK_CANDLES + 1);
  const candidateReturns = returnsFromCloses(candidateCloses);

  const correlated: { symbol: string; correlation: number | null }[] = [];
  let heldCorrelatedNotional = 0;

  for (const held of i.heldPositions) {
    if (held.symbol === i.candidateSymbol) {
      // Same symbol is the same bet by definition — no correlation read needed.
      correlated.push({ symbol: held.symbol, correlation: 1 });
      heldCorrelatedNotional += held.notional;
      continue;
    }
    const heldCloses = await i.closesAsOf(held.symbol as MarketSymbol, i.timeframe, CORRELATION_LOOKBACK_CANDLES + 1);
    const heldReturns = returnsFromCloses(heldCloses);
    const n = Math.min(candidateReturns.length, heldReturns.length);
    if (n < MIN_RETURN_POINTS) {
      // Not enough overlapping history to measure — bucket it (pessimistic, see header).
      correlated.push({ symbol: held.symbol, correlation: null });
      heldCorrelatedNotional += held.notional;
      continue;
    }
    // Align on the most recent n returns of each series.
    const corr = pearson(candidateReturns.slice(-n), heldReturns.slice(-n));
    if (corr >= threshold) {
      correlated.push({ symbol: held.symbol, correlation: corr });
      heldCorrelatedNotional += held.notional;
    }
  }

  const bucketNotional = i.candidateNotional + heldCorrelatedNotional;
  const cap = i.maxCorrelatedExposure * i.candidateNotional;
  if (heldCorrelatedNotional > 0 && bucketNotional > cap) {
    return { ok: false, bucketNotional, cap, correlated };
  }
  return { ok: true, bucketNotional, correlated };
}
