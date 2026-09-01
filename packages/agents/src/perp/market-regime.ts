/**
 * Perp Market Regime Agent (§40.3). CADENCE on primary-TF close. Classifies the market into
 * `{BULL, BEAR, RANGE, HIGH_VOL, LOW_CONFIDENCE}` and produces a directional bias.
 *
 * Uses the same simplified ATR + EMA-slope proxy as the memecoin variant (§40.11) for MVP —
 * proper ADX is a follow-up refinement.
 */
import { and, asc, eq, lte } from 'drizzle-orm';
import type { DomainEvent } from '@tip/domain';
import { marketCandle } from '@tip/database';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';
import { atr, ema } from './indicators.js';

const KEY = 'perp.market_regime';
const VERSION = 1;
export type PerpRegime = 'BULL' | 'BEAR' | 'RANGE' | 'HIGH_VOL' | 'LOW_CONFIDENCE';

interface KlinePayload { symbol: string; timeframe: string; closeTime: string }

export const perpMarketRegimeAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'CADENCE',
  canHandle(event) { return event.type === EVENT_NAMES.PERP_KLINE_CLOSED; },
  async analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as KlinePayload;
    if (p.timeframe !== ctx.primaryTf) return null;
    const closeTime = new Date(p.closeTime);

    const rows = await ctx.db
      .select({ high: marketCandle.high, low: marketCandle.low, close: marketCandle.close })
      .from(marketCandle)
      .where(and(eq(marketCandle.symbol, p.symbol), eq(marketCandle.timeframe, ctx.primaryTf), lte(marketCandle.closeTime, closeTime)))
      .orderBy(asc(marketCandle.openTime))
      .limit(60);
    if (rows.length < 30) {
      return {
        agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0.4,
        features: { symbol: p.symbol, regime: 'LOW_CONFIDENCE', candles: rows.length },
      };
    }

    const closes = rows.map((r) => Number(r.close));
    const candles = rows.map((r) => ({ high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    const a14 = atr(candles, 14);
    const rolling = atr(candles.slice(-30), 14);
    const atrRatio = a14 !== null && rolling !== null && rolling > 0 ? a14 / rolling : null;

    const e50 = ema(closes, 50);
    const last = e50[e50.length - 1]!;
    const prior = e50[e50.length - 6] ?? last;
    const slopePct = prior > 0 ? (last - prior) / prior : 0;

    let regime: PerpRegime;
    let bias = 0;
    let confidence = 0.7;
    if (atrRatio !== null && atrRatio > 1.5) {
      regime = 'HIGH_VOL';
      confidence = 0.75;
    } else if (Math.abs(slopePct) < 0.005) {
      regime = 'RANGE';
    } else if (slopePct > 0) {
      regime = 'BULL';
      bias = Math.min(1, 0.6 + slopePct * 10);
      confidence = Math.min(0.95, 0.7 + Math.abs(slopePct) * 10);
    } else {
      regime = 'BEAR';
      bias = Math.max(-1, -0.6 + slopePct * 10);
      confidence = Math.min(0.95, 0.7 + Math.abs(slopePct) * 10);
    }

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: bias > 0 ? 'LONG' : bias < 0 ? 'SHORT' : 'NEUTRAL',
      score: bias,
      confidence,
      features: { symbol: p.symbol, regime, slopePct, atrRatio },
    };
  },
};
