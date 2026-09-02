/**
 * Perp Trade Planner (Part III §4). Signal → TradeSetup with entry / SL / TP derived from
 * MARKET STRUCTURE — ATR + swing pivots — plus the trading agent's own risk config.
 *
 * TP/SL are never produced by an LLM (rule 13). This module is fully deterministic over the
 * candle window it reads, which is what makes change 6 (Brain Seeding) replayable.
 *
 * Style → ATR-window mapping per §8: scalp/5m, day/1h, swing/4h.
 */
import type { MarketSymbol, Timeframe } from '@tip/domain';
import { ValidationError } from '@tip/domain';
import type { AsOfMarketData } from '@tip/evaluation';
import type { ScoringConfig, TradingStyle } from '@tip/trading-agents';
import { atr } from './atr.js';
import { evaluateCorrelatedExposure, type HeldPosition } from './correlation.js';
import { positionSize, deriveLeverage } from './sizing.js';
import { collapsePivots, nearestLevels, swingPivots, type StructureBar } from './structure.js';
import { HORIZON_MS, planningHorizon } from './horizons.js';
import type { PlanResult, TradeSetup } from './types.js';

const ATR_TIMEFRAME: Record<TradingStyle, Timeframe> = { scalp: '5m', day: '1h', swing: '4h' };
const ATR_PERIOD = 14;
const LOOKBACK = 100;                    // bars from which pivots are drawn — MVP default, tunable
const PIVOT_K = 2;                       // both-side confirmation length — the standard fractal
const COLLAPSE_ATR_FACTOR = 0.25;        // pivots within this many ATRs are one level
const ATR_FALLBACK_MULT = 1.5;           // stop distance when no pivot is available (Part III §4)

export interface PerpPlanInputs {
  symbol: MarketSymbol;
  direction: 'LONG' | 'SHORT';
  style: TradingStyle;
  config: ScoringConfig;
  configVersion: number;
  balance: number;
  /** Bybit linear ≈ 0.005; carried on config rather than hardcoded (exchange policy changes). */
  maintenanceMarginRate?: number;
  exchangeMaxLeverage?: number;
  view: AsOfMarketData;
  /**
   * Currently-held (OPEN + PENDING_ENTRY, non-shadow) positions for the §37
   * maxCorrelatedExposure gate (audit #14). Optional: absent/empty ⇒ the gate passes trivially,
   * which is exact under one-symbol-per-agent + maxConcurrentPositions=1.
   */
  heldPositions?: readonly HeldPosition[];
}

export async function planPerp(i: PerpPlanInputs): Promise<PlanResult> {
  const tf = ATR_TIMEFRAME[i.style];
  const rows = await i.view.candlesAsOf(i.symbol, tf, LOOKBACK);
  if (rows.length < ATR_PERIOD + 1) {
    return { kind: 'NO_TRADE', reason: 'STALE_OR_MISSING_DATA', detail: `only ${rows.length} bars ${tf} at ${i.view.asOf.toISOString()}` };
  }

  const bars = rows.map((r) => ({ high: Number(r.high), low: Number(r.low), close: Number(r.close), closeTime: r.closeTime }));
  const structureBars: StructureBar[] = bars.map((b) => ({ high: b.high, low: b.low, closeTime: b.closeTime }));

  const a = atr(bars, ATR_PERIOD);
  if (!a || a <= 0) return { kind: 'NO_TRADE', reason: 'NO_STOP_DERIVABLE', detail: 'ATR unavailable' };

  const lastClose = bars[bars.length - 1]!.close;
  // LIMIT entry: pull back from the close by `limitPullbackAtr × ATR` in the direction that
  // gives us a BETTER fill (LONG buys lower, SHORT sells higher). Guard against a degenerate
  // ATR read producing an unreachable limit (5×ATR is defensive, not tuned).
  const entryType = i.config.entryType ?? 'MARKET';
  const pullback = (i.config.limitPullbackAtr ?? 0.3) * a;
  let entry: number;
  if (entryType === 'MARKET') {
    entry = lastClose;
  } else {
    entry = i.direction === 'LONG' ? lastClose - pullback : lastClose + pullback;
    if (entry <= 0 || Math.abs(entry - lastClose) > 5 * a) {
      return { kind: 'NO_TRADE', reason: 'STALE_OR_MISSING_DATA', detail: `LIMIT ${entry.toFixed(2)} too far from close ${lastClose.toFixed(2)}` };
    }
  }
  const pivots = collapsePivots(swingPivots(structureBars, PIVOT_K), a, COLLAPSE_ATR_FACTOR);
  const { supportBelow, resistanceAbove } = nearestLevels(entry, pivots);

  // Stop: opposing-side pivot; fall back to ±ATR_FALLBACK_MULT×ATR; refuse when even that would
  // be non-positive (a degenerate configuration guarded against for defence, not observed).
  let stopLoss: number;
  let takeProfit: number;
  if (i.direction === 'LONG') {
    stopLoss = supportBelow ? supportBelow.price : entry - ATR_FALLBACK_MULT * a;
    takeProfit = resistanceAbove ? resistanceAbove.price : entry + ATR_FALLBACK_MULT * a * (i.config.minRR ?? 1.5);
  } else {
    stopLoss = resistanceAbove ? resistanceAbove.price : entry + ATR_FALLBACK_MULT * a;
    takeProfit = supportBelow ? supportBelow.price : entry - ATR_FALLBACK_MULT * a * (i.config.minRR ?? 1.5);
  }

  if (stopLoss <= 0 || takeProfit <= 0) {
    return { kind: 'NO_TRADE', reason: 'NO_STOP_DERIVABLE', detail: 'derived non-positive level' };
  }

  const stopDist = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  const rr = reward / stopDist;
  if (rr < i.config.minRR) {
    return { kind: 'NO_TRADE', reason: 'INSUFFICIENT_RR', detail: `R:R ${rr.toFixed(2)} < minRR ${i.config.minRR}` };
  }

  let sizing;
  try {
    sizing = positionSize({ balance: i.balance, riskPercent: i.config.riskPercent, entry, stopLoss, direction: i.direction });
  } catch (e) {
    if (e instanceof ValidationError) return { kind: 'NO_TRADE', reason: 'NO_STOP_DERIVABLE', detail: e.message };
    throw e;
  }

  const leverage = deriveLeverage({
    entry, stopLoss, direction: i.direction,
    maintenanceMarginRate: i.maintenanceMarginRate ?? 0.005,
    exchangeMaxLeverage: i.exchangeMaxLeverage ?? 100,
    userMaxLeverage: i.config.leverageMax ?? 10,
  }, sizing.notional);

  if (leverage.requiredMargin > i.balance) {
    return { kind: 'NO_TRADE', reason: 'CANNOT_SIZE_SAFELY',
      detail: `margin ${leverage.requiredMargin.toFixed(2)} > balance ${i.balance}; leverage not raised to fit` };
  }

  // §37 maxCorrelatedExposure (audit #14) — same enforcement point as the leverage and min-R:R
  // checks per §2114. Only evaluated when there are actual holdings to correlate against.
  if (i.heldPositions && i.heldPositions.length > 0) {
    const capMultiple = i.config.maxCorrelatedExposure ?? 1;
    const corr = await evaluateCorrelatedExposure({
      candidateSymbol: i.symbol,
      candidateNotional: sizing.notional,
      heldPositions: i.heldPositions,
      maxCorrelatedExposure: capMultiple,
      closesAsOf: async (sym, timeframe, limit) =>
        (await i.view.candlesAsOf(sym, timeframe, limit)).map((r) => Number(r.close)),
      timeframe: tf,
    });
    if (!corr.ok) {
      return { kind: 'NO_TRADE', reason: 'CORRELATED_EXPOSURE_CAP',
        detail: `correlated bucket ${corr.bucketNotional.toFixed(2)} > cap ${corr.cap.toFixed(2)} (${corr.correlated.map((c) => `${c.symbol}:${c.correlation === null ? 'no-data' : c.correlation.toFixed(2)}`).join(', ')})` };
    }
  }

  const horizon = planningHorizon(i.style, 'perp');
  const setup: TradeSetup = {
    symbol: i.symbol, domain: 'perp', direction: i.direction, entryType,
    entry, stopLoss, takeProfit,
    riskReward: rr,
    positionSize: sizing.positionSize, notional: sizing.notional,
    leverage: leverage.allowed, requiredMargin: leverage.requiredMargin,
    horizon, plannedAt: i.view.asOf, configVersion: i.configVersion,
  };
  return { kind: 'TRADE', setup };
}

export const _test = { HORIZON_MS, ATR_TIMEFRAME, LOOKBACK, PIVOT_K };
