/**
 * Perp Momentum Agent (§40.1). CADENCE + CONDITIONAL — fires on primary-TF `perp.kline.closed`.
 * Composite formula (§40.1):
 *   score = 0.4 · alignment + 0.3 · slope + 0.15 · rsi + 0.15 · macd    ∈ [-1, +1]
 *   confidence = 1 − stddev(sub_signs)/2
 *
 * CONDITIONAL skip: candle range < 0.25 × ATR(14) AND volume < 0.5 × avg(20).
 */
import { and, asc, eq, lte } from 'drizzle-orm';
import type { DomainEvent } from '@tip/domain';
import { marketCandle } from '@tip/database';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';
import { ANALYSIS_TFS_FOR_PRIMARY } from '@tip/trading-agents';
import { EVENT_NAMES } from '@tip/events';
import { ema, rsi, macdHistogram, atr } from './indicators.js';

const KEY = 'perp.momentum';
const VERSION = 1;

interface KlinePayload { symbol: string; timeframe: string; closeTime: string; open: string; high: string; low: string; close: string; volume: string }

function emaAlignment(closes: number[]): number {
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  if (closes.length < 50) return 0;
  const a = e9[e9.length - 1]!;
  const b = e21[e21.length - 1]!;
  const c = e50[e50.length - 1]!;
  // Fully aligned bull: 9>21>50 → +1; bear reverse → -1; else proportional.
  const pairs = [a > b ? 1 : a < b ? -1 : 0, b > c ? 1 : b < c ? -1 : 0];
  return (pairs[0]! + pairs[1]!) / 2;
}

function slopeScore(closes: number[]): number {
  const e21 = ema(closes, 21);
  if (e21.length < 6) return 0;
  const last = e21[e21.length - 1]!;
  const prior = e21[e21.length - 6]!;
  if (prior === 0) return 0;
  const slopePctPerCandle = ((last - prior) / prior) / 5;
  return Math.max(-1, Math.min(1, slopePctPerCandle / 0.02));
}

function rsiScore(closes: number[]): number {
  const r = rsi(closes, 14);
  if (r === null) return 0;
  if (r <= 30) return Math.max(0, Math.min(1, (30 - r) / 30));
  if (r >= 70) return -Math.max(0, Math.min(1, (r - 70) / 30));
  if (r >= 40 && r <= 60) return 0;
  return r < 40 ? (40 - r) / 20 * 0.5 : -(r - 60) / 20 * 0.5;
}

function macdScore(closes: number[]): number {
  const { hist, magnitude } = macdHistogram(closes);
  if (hist === null || magnitude === null || magnitude === 0) return 0;
  return Math.max(-1, Math.min(1, hist / magnitude));
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}


/**
 * Multi-TF confirmation (§8). Reads EMA(9,21,50) alignment on EACH analysis TF for the style and
 * returns the FRACTION that agree with the primary-TF direction, in [0,1]. 1.0 = every TF aligns
 * (strong confirmation); 0.33 = only the primary agrees (weak, likely a lower-TF head-fake).
 * Used to scale Momentum's confidence — the plan's whole point of a multi-TF stack.
 */
async function multiTfConfirmation(
  db: AgentContext['db'], symbol: string, primaryTf: string, at: Date, primarySign: number,
): Promise<{ fraction: number; perTf: Record<string, number> }> {
  const stack = ANALYSIS_TFS_FOR_PRIMARY[primaryTf as '5m' | '1h' | '4h'] ?? [primaryTf];
  const perTf: Record<string, number> = {};
  let agree = 0;
  for (const tf of stack) {
    const rows = await db.select({ close: marketCandle.close })
      .from(marketCandle)
      .where(and(eq(marketCandle.symbol, symbol), eq(marketCandle.timeframe, tf), lte(marketCandle.closeTime, at)))
      .orderBy(asc(marketCandle.openTime)).limit(60);
    if (rows.length < 30) { perTf[tf] = 0; continue; }
    const closes = rows.map((r) => Number(r.close));
    const sign = Math.sign(emaAlignment(closes));
    perTf[tf] = sign;
    if (primarySign !== 0 && sign === primarySign) agree++;
  }
  return { fraction: stack.length > 0 ? agree / stack.length : 0, perTf };
}

export const perpMomentumAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'CONDITIONAL',
  canHandle(event) {
    if (event.type !== EVENT_NAMES.PERP_KLINE_CLOSED) return false;
    return true;
  },
  async analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as KlinePayload;
    if (p.timeframe !== ctx.primaryTf) return null;

    const rows = await ctx.db
      .select({ high: marketCandle.high, low: marketCandle.low, close: marketCandle.close, volume: marketCandle.volume })
      .from(marketCandle)
      .where(and(eq(marketCandle.symbol, p.symbol), eq(marketCandle.timeframe, ctx.primaryTf), lte(marketCandle.closeTime, new Date(p.closeTime))))
      .orderBy(asc(marketCandle.openTime))
      .limit(60);
    if (rows.length < 30) {
      return {
        agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0.3,
        features: { symbol: p.symbol, insufficientHistory: true, candles: rows.length },
      };
    }

    const closes = rows.map((r) => Number(r.close));
    const highs = rows.map((r) => Number(r.high));
    const lows = rows.map((r) => Number(r.low));
    const volumes = rows.map((r) => Number(r.volume));
    const candles = rows.map((r) => ({ high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    const a = atr(candles, 14);
    const range = highs[highs.length - 1]! - lows[lows.length - 1]!;
    const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(20, volumes.length));
    const currentVol = volumes[volumes.length - 1]!;

    // CONDITIONAL dead-candle skip.
    if (a !== null && range < 0.25 * a && currentVol < 0.5 * avgVol) {
      return {
        agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0,
        features: { symbol: p.symbol, skipReason: 'dead-candle', range, atr14: a, currentVol, avgVol },
        skipped: true,
      };
    }

    const alignment = emaAlignment(closes);
    const slope = slopeScore(closes);
    const rsiV = rsiScore(closes);
    const macd = macdScore(closes);
    const composite = Math.max(-1, Math.min(1, 0.4 * alignment + 0.3 * slope + 0.15 * rsiV + 0.15 * macd));

    const signs = [alignment, slope, rsiV, macd].map((s) => (s === 0 ? 0 : Math.sign(s)));
    const agentAgreement = Math.max(0.3, Math.min(1, 1 - stddev(signs) / 2));

    // Multi-TF confirmation (§8). Read the analysis-TF stack; scale confidence by how many TFs
    // agree with the primary-TF direction. A signal confirmed on 15m + 1h + 4h is worth more
    // than one that only shows on the primary — a lower-TF head-fake gets down-weighted.
    const mtf = await multiTfConfirmation(ctx.db, p.symbol, ctx.primaryTf, new Date(p.closeTime), Math.sign(composite));
    // Blend: agent-internal agreement × TF-stack agreement. Full alignment keeps confidence;
    // primary-only (fraction ≈ 1/3) roughly halves it.
    const confidence = Math.max(0.2, Math.min(1, agentAgreement * (0.5 + 0.5 * mtf.fraction)));

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: composite > 0 ? 'LONG' : composite < 0 ? 'SHORT' : 'NEUTRAL',
      score: composite,
      confidence,
      features: {
        symbol: p.symbol, alignment, slope, rsi: rsi(closes, 14), macd, currentVol, avgVol, atr14: a,
        multiTfFraction: mtf.fraction, multiTfPerTf: mtf.perTf,
      },
    };
  },
};
