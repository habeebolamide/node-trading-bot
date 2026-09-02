/**
 * Perp Market Regime Agent (§40.3). CADENCE on primary-TF close. Classifies into
 * `{BULL, BEAR, RANGE, HIGH_VOL, LOW_CONFIDENCE}` and emits the directional bias.
 *
 * Rebuilt per the audit-2 B4 findings against the §40.3 spec, verbatim rules:
 *   ATR ratio > 1.5                    → HIGH_VOL   (overrides trend classification)
 *   ADX < 20                           → RANGE
 *   ADX ≥ 20 AND higher-TF slope > 0   → BULL   (bias +0.6…+1.0, scaled by ADX + slope)
 *   ADX ≥ 20 AND higher-TF slope < 0   → BEAR   (bias −0.6…−1.0)
 * with real Wilder ADX(14) on the primary TF (was an EMA-slope proxy), trend DIRECTION from
 * EMA(50) slope on the NEXT-HIGHER TF (was missing entirely — primary TF only), and the ATR
 * ratio ORIENTED correctly: current ATR(14) ÷ trailing 30-candle average true range (the old
 * code compared a full-window ATR against a recent-window ATR, so HIGH_VOL fired when the
 * OLDER window was more volatile — and that inverted value fed the fingerprint's volatility
 * dimension).
 *
 * Edge cases per spec: higher-TF buffer not warm → primary-TF slope stands in, confidence
 * capped at 0.5, regime tagged LOW_CONFIDENCE. Dead market (zero rolling ATR) → RANGE, vol
 * classification skipped.
 */
import type { DomainEvent } from '@tip/domain';
import { recentCandlesAsOf } from '../common/candles.js';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';
import { adx, atr, ema, trueRange } from './indicators.js';

const KEY = 'perp.market_regime';
const VERSION = 1;
export type PerpRegime = 'BULL' | 'BEAR' | 'RANGE' | 'HIGH_VOL' | 'LOW_CONFIDENCE';

/** §40.3 "primary TF plus one higher" — day style reads 1h primary + 4h context, etc. */
const HIGHER_TF: Record<string, string> = { '1m': '5m', '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d' };

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

    const rows = await recentCandlesAsOf(ctx.db, p.symbol, ctx.primaryTf, closeTime, 60);
    if (rows.length < 50) { // §40.3 input: minimum 50 primary candles
      return {
        agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0.4,
        features: { symbol: p.symbol, regime: 'LOW_CONFIDENCE', candles: rows.length },
      };
    }
    const candles = rows.map((r) => ({ high: Number(r.high), low: Number(r.low), close: Number(r.close) }));

    // 1. Trend strength — Wilder ADX(14), primary TF.
    const adx14 = adx(candles, 14);

    // 2. Trend direction — EMA(50) slope on the higher TF (%/candle). Falls back to the
    //    primary-TF slope with the LOW_CONFIDENCE cap when the higher buffer isn't warm.
    const higherTf = HIGHER_TF[ctx.primaryTf];
    let slopeSource: 'higher' | 'primary' = 'primary';
    let slopeCloses = candles.map((c) => c.close);
    if (higherTf) {
      const higher = await recentCandlesAsOf(ctx.db, p.symbol, higherTf, closeTime, 60);
      if (higher.length >= 30) { // §40.3 input: minimum 30 higher-TF candles
        slopeCloses = higher.map((r) => Number(r.close));
        slopeSource = 'higher';
      }
    }
    const e50 = ema(slopeCloses, 50);
    const last = e50[e50.length - 1]!;
    const prior = e50[e50.length - 6] ?? last;
    const slopePct = prior > 0 ? ((last - prior) / prior) / 5 : 0; // %/candle over 5 candles
    const lowConfidence = slopeSource === 'primary';

    // 3. Volatility state — current ATR(14) ÷ trailing 30-candle average TR (correct orientation).
    const currentAtr = atr(candles.slice(-15), 14);
    const trs: number[] = [];
    for (let i = Math.max(1, candles.length - 30); i < candles.length; i++) trs.push(trueRange(candles, i));
    const rollingAvg = trs.length > 0 ? trs.reduce((a, b) => a + b, 0) / trs.length : 0;
    const atrRatio = currentAtr !== null && rollingAvg > 0 ? currentAtr / rollingAvg : null;

    let regime: PerpRegime;
    let bias = 0;
    let confidence: number;
    if (atrRatio !== null && atrRatio > 1.5) {
      regime = 'HIGH_VOL'; // overrides trend classification; directionally neutral (risk-off)
      confidence = Math.min(0.95, 0.6 + (atrRatio - 1.5) * 0.5);
    } else if (adx14 === null || adx14 < 20 || rollingAvg === 0) {
      regime = 'RANGE'; // includes the dead-market edge case (zero rolling ATR)
      confidence = adx14 === null ? 0.4 : Math.min(0.9, 0.5 + (20 - adx14) / 40);
    } else if (slopePct > 0) {
      regime = 'BULL';
      bias = Math.min(1, 0.6 + Math.min(0.2, (adx14 - 20) / 100) + Math.min(0.2, slopePct * 50));
      confidence = Math.min(0.95, 0.6 + Math.min(0.35, (adx14 - 20) / 40));
    } else {
      regime = 'BEAR';
      bias = Math.max(-1, -(0.6 + Math.min(0.2, (adx14 - 20) / 100) + Math.min(0.2, Math.abs(slopePct) * 50)));
      confidence = Math.min(0.95, 0.6 + Math.min(0.35, (adx14 - 20) / 40));
    }
    if (lowConfidence) {
      regime = regime === 'BULL' || regime === 'BEAR' ? regime : 'LOW_CONFIDENCE';
      confidence = Math.min(confidence, 0.5); // §40.3 higher-TF-not-warm cap
    }

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: bias > 0 ? 'LONG' : bias < 0 ? 'SHORT' : 'NEUTRAL',
      score: bias,
      confidence,
      features: {
        symbol: p.symbol, regime, adx: adx14, higherTfSlopePct: slopePct * 100,
        atrRatio, slopeSource, lowConfidence,
      },
    };
  },
};
