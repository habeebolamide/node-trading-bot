/**
 * Perp Risk Agent input loader (§40.12 — audit-2 A3 wiring: the Risk Agent had no live caller).
 *
 * The Risk Agent runs on `signal.created`, AFTER the composite has been scored and every
 * agent's raw features have been persisted to `signal_feature`. We reuse those persisted values
 * instead of recomputing anything — that's the whole point of writing them (§9).
 *
 * The pivot-based S/R levels aren't persisted, so we compute them here from the same candle
 * window the planner uses (structure.ts). This is the same look-ahead-safe read pattern —
 * candles filtered by closeTime ≤ the signal's createdAt.
 */
import { and, eq, lte } from 'drizzle-orm';
import { marketCandle, signal, signalFeature, type Db } from '@tip/database';
import { recentCandlesAsOf } from '@tip/agents';
import { atr, ema } from '@tip/agents';
import type { PerpRiskInputs } from '@tip/agents';
import { collapsePivots, nearestLevels, swingPivots } from '@tip/planner';
import { PRIMARY_TF, type TradingStyle } from '@tip/trading-agents';

const ATR_TIMEFRAME: Record<TradingStyle, string> = { scalp: '5m', day: '1h', swing: '4h' };
const LOOKBACK = 100;

interface SignalCreatedPayload {
  signalId: string; tradingAgentId: string; symbol: string; domain: 'perp' | 'memecoin';
  direction: string;
}

/** Build the perp risk-input snapshot for one signal, or null if any required piece is absent. */
export async function loadPerpRiskInputs(db: Db, style: TradingStyle, p: SignalCreatedPayload): Promise<PerpRiskInputs | null> {
  const sig = (await db.select({ createdAt: signal.createdAt }).from(signal).where(eq(signal.id, p.signalId)).limit(1))[0];
  if (!sig) return null;
  const at = sig.createdAt;
  const primaryTf = PRIMARY_TF[style];
  const tf = ATR_TIMEFRAME[style];

  // Structure candles for pivots + entry — same window the planner uses.
  const rows = await db.select({
    high: marketCandle.high, low: marketCandle.low, close: marketCandle.close, closeTime: marketCandle.closeTime,
  })
    .from(marketCandle)
    .where(and(eq(marketCandle.symbol, p.symbol), eq(marketCandle.timeframe, tf), lte(marketCandle.closeTime, at)))
    .orderBy(marketCandle.closeTime);
  if (rows.length < 30) return null;
  const bars = rows.slice(-LOOKBACK).map((r) => ({
    high: Number(r.high), low: Number(r.low), close: Number(r.close), closeTime: r.closeTime,
  }));
  const entry = bars[bars.length - 1]!.close;
  const a14 = atr(bars, 14);
  if (a14 === null || a14 <= 0) return null;

  const pivots = collapsePivots(swingPivots(bars.map((b) => ({ high: b.high, low: b.low, closeTime: b.closeTime })), 2), a14, 0.25);
  const { supportBelow, resistanceAbove } = nearestLevels(entry, pivots);

  // Feature reads: pull the persisted per-agent features by (signalId, agentKey).
  const feats = await db.select().from(signalFeature).where(eq(signalFeature.signalId, p.signalId));
  const byAgent = new Map(feats.map((f) => [f.agentKey, f.features as Record<string, unknown>]));

  const fundingPercentile30d = numberOr(byAgent.get('perp.funding')?.percentile30d, null);
  const oiPercentile30d = numberOr(byAgent.get('perp.open_interest')?.oiPercentile30d, null);
  const atrRatio = numberOr(byAgent.get('perp.market_regime')?.atrRatio, null);

  // EMA(50) distance in ATR — uses the same primary-TF window the momentum agent read.
  const primaryCandles = await recentCandlesAsOf(db, p.symbol, primaryTf, at, 60);
  let emaDistanceInAtr: number | null = null;
  if (primaryCandles.length >= 50) {
    const closes = primaryCandles.map((c) => Number(c.close));
    const e50 = ema(closes, 50);
    const last = e50[e50.length - 1]!;
    const close = closes[closes.length - 1]!;
    emaDistanceInAtr = a14 > 0 ? (close - last) / a14 : null;
  }

  return {
    direction: (p.direction.endsWith('LONG') ? 'LONG' : p.direction.endsWith('SHORT') ? 'SHORT' : 'NEUTRAL'),
    entryPrice: entry, atr14: a14,
    nearestSupport: supportBelow?.price ?? null,
    nearestResistance: resistanceAbove?.price ?? null,
    fundingPercentile30d, oiPercentile30d, atrRatio, emaDistanceInAtr,
  };
}

function numberOr(v: unknown, fallback: number | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
