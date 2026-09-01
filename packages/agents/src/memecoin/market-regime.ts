/**
 * Memecoin Market Regime Agent (§40.11). Same mechanics as the perp Market Regime (§40.3),
 * scoped to SOL as the base market — memecoin performance correlates strongly with SOL regime.
 * CADENCE on SOL primary-TF close.
 *
 * MVP: identifies regime as one of `{BULL, BEAR, RANGE, HIGH_VOL}` from SOL kline history stored
 * in `market_candle` (populated by the M1 Bybit adapter). Directional bias contributes to the
 * memecoin composite (weight 5%).
 *
 * Regime classification via ATR / EMA slope thresholds — simplified ADX proxy for MVP; the
 * perp version (change 4) will share the deeper implementation.
 */
import { and, asc, eq, lte } from 'drizzle-orm';
import type { DomainEvent } from '@tip/domain';
import { marketCandle } from '@tip/database';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';

const KEY = 'memecoin.market_regime';
const VERSION = 1;
const EVENT_TYPE = 'perp.kline.closed'; // memecoin regime reads the SOL kline stream too
const SOL_SYMBOL = 'SOLUSDT';

export type Regime = 'BULL' | 'BEAR' | 'RANGE' | 'HIGH_VOL' | 'LOW_CONFIDENCE';

interface Payload { symbol: string; timeframe: string; closeTime: string }

function emaSlopePct(closes: readonly number[], span: number): number | null {
  if (closes.length < span + 5) return null;
  const k = 2 / (span + 1);
  let ema = closes[0]!;
  const emas: number[] = [];
  for (const c of closes) {
    ema = c * k + ema * (1 - k);
    emas.push(ema);
  }
  const first = emas[emas.length - 6]!;
  const last = emas[emas.length - 1]!;
  if (first <= 0) return null;
  return (last - first) / first;
}

function atrRatio(candles: { high: string; low: string; close: string }[]): number | null {
  if (candles.length < 30) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = Number(candles[i]!.high);
    const l = Number(candles[i]!.low);
    const pc = Number(candles[i - 1]!.close);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const window14 = trs.slice(-14);
  const rolling = trs.slice(-30);
  const cur = window14.reduce((s, x) => s + x, 0) / window14.length;
  const avg = rolling.reduce((s, x) => s + x, 0) / rolling.length;
  return avg > 0 ? cur / avg : null;
}

export const memecoinMarketRegimeAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'CADENCE',
  canHandle(event) {
    if (event.type !== EVENT_TYPE) return false;
    const p = event.payload as Payload;
    return p.symbol === SOL_SYMBOL;
  },
  async analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as Payload;
    const closeTime = new Date(p.closeTime);
    // Read the last N SOL candles at primary TF <= now.
    const rows = await ctx.db
      .select({ high: marketCandle.high, low: marketCandle.low, close: marketCandle.close })
      .from(marketCandle)
      .where(
        and(
          eq(marketCandle.symbol, SOL_SYMBOL),
          eq(marketCandle.timeframe, ctx.primaryTf),
          lte(marketCandle.closeTime, closeTime),
        ),
      )
      .orderBy(asc(marketCandle.openTime))
      .limit(50);
    if (rows.length < 30) {
      return {
        agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0.4,
        features: { regime: 'LOW_CONFIDENCE', candles: rows.length },
      };
    }

    const closes = rows.map((r) => Number(r.close));
    const slope = emaSlopePct(closes, 50) ?? 0;
    const atr = atrRatio(rows);

    let regime: Regime;
    let bias = 0;
    let confidence = 0.7;
    if (atr !== null && atr > 1.5) {
      regime = 'HIGH_VOL';
      bias = 0;
      confidence = 0.75;
    } else if (Math.abs(slope) < 0.005) {
      regime = 'RANGE';
      bias = 0;
      confidence = 0.7;
    } else if (slope > 0) {
      regime = 'BULL';
      bias = Math.min(1, 0.6 + slope * 10);
      confidence = Math.min(0.95, 0.7 + Math.abs(slope) * 10);
    } else {
      regime = 'BEAR';
      bias = Math.max(-1, -0.6 + slope * 10);
      confidence = Math.min(0.95, 0.7 + Math.abs(slope) * 10);
    }

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: bias > 0 ? 'LONG' : bias < 0 ? 'SHORT' : 'NEUTRAL',
      score: bias,
      confidence,
      features: { regime, slopePct: slope, atrRatio: atr, candles: rows.length },
    };
  },
};
