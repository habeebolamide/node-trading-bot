/**
 * Perp Open Interest Agent (§40.2). CADENCE on primary-TF close. 4-candle Δprice × ΔOI → 2×2
 * quadrant:
 *
 *                Price ↑                    Price ↓
 *   OI ↑     TREND_CONFIRM_BULL          NEW_SHORTS_BEAR
 *              +0.7 to +1.0                -0.7 to -1.0
 *   OI ↓     SHORT_COVERING (weak long)  LONG_UNWIND (weak short)
 *              +0.2 to +0.5                -0.2 to -0.5
 *
 * Magnitude scaled by |Δprice| + |ΔOI|. Confidence high when both deltas are substantial;
 * near-zero when either is flat.
 */
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import type { DomainEvent } from '@tip/domain';
import { marketCandle, openInterest as oiTable } from '@tip/database';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';

const KEY = 'perp.open_interest';
const VERSION = 1;

interface KlinePayload { symbol: string; timeframe: string; closeTime: string }

export type OIQuadrant = 'TREND_CONFIRM_BULL' | 'SHORT_COVERING' | 'NEW_SHORTS_BEAR' | 'LONG_UNWIND' | 'NEUTRAL';

function classify(dPrice: number, dOI: number): { quadrant: OIQuadrant; magnitude: number } {
  const magnitude = Math.abs(dPrice) + Math.abs(dOI);
  if (Math.abs(dPrice) < 0.001 || Math.abs(dOI) < 0.001) return { quadrant: 'NEUTRAL', magnitude };
  if (dPrice > 0 && dOI > 0) return { quadrant: 'TREND_CONFIRM_BULL', magnitude };
  if (dPrice < 0 && dOI > 0) return { quadrant: 'NEW_SHORTS_BEAR', magnitude };
  if (dPrice > 0 && dOI < 0) return { quadrant: 'SHORT_COVERING', magnitude };
  return { quadrant: 'LONG_UNWIND', magnitude };
}

function scoreFor(q: OIQuadrant, magnitude: number): number {
  const strong = Math.min(1, magnitude / 0.05); // saturate at combined 5%
  const weak = Math.min(0.5, magnitude / 0.05);
  switch (q) {
    case 'TREND_CONFIRM_BULL': return 0.7 * strong + 0.3;
    case 'NEW_SHORTS_BEAR': return -(0.7 * strong + 0.3);
    case 'SHORT_COVERING': return 0.2 + weak;
    case 'LONG_UNWIND': return -(0.2 + weak);
    default: return 0;
  }
}

export const perpOpenInterestAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'CADENCE',
  canHandle(event) { return event.type === EVENT_NAMES.PERP_KLINE_CLOSED; },
  async analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as KlinePayload;
    if (p.timeframe !== ctx.primaryTf) return null;
    const closeTime = new Date(p.closeTime);

    const candles = await ctx.db
      .select({ close: marketCandle.close })
      .from(marketCandle)
      .where(and(eq(marketCandle.symbol, p.symbol), eq(marketCandle.timeframe, ctx.primaryTf), lte(marketCandle.closeTime, closeTime)))
      .orderBy(asc(marketCandle.openTime))
      .limit(5);
    if (candles.length < 5) return { agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0, features: { symbol: p.symbol, insufficientHistory: true } };

    const oiRows = await ctx.db
      .select({ oi: oiTable.oi })
      .from(oiTable)
      .where(and(eq(oiTable.symbol, p.symbol), lte(oiTable.snapshotTime, closeTime)))
      .orderBy(desc(oiTable.snapshotTime))
      .limit(5);
    if (oiRows.length < 5) return { agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0, features: { symbol: p.symbol, insufficientOI: true } };
    const oiValues = oiRows.reverse().map((r) => Number(r.oi));

    const first = Number(candles[0]!.close);
    const last = Number(candles[candles.length - 1]!.close);
    const dPrice = first > 0 ? (last - first) / first : 0;
    const dOI = oiValues[0]! > 0 ? (oiValues[oiValues.length - 1]! - oiValues[0]!) / oiValues[0]! : 0;

    const { quadrant, magnitude } = classify(dPrice, dOI);
    const score = scoreFor(quadrant, magnitude);
    const confidence = Math.max(0, Math.min(1, magnitude / 0.05));

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: score > 0 ? 'LONG' : score < 0 ? 'SHORT' : 'NEUTRAL',
      score,
      confidence,
      features: { symbol: p.symbol, quadrant, priceDeltaPct: dPrice, oiDeltaPct: dOI },
    };
  },
};
