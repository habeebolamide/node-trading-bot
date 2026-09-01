/**
 * Memecoin Momentum Agent (§40.9). CADENCE + CONDITIONAL. Fires on the primary-TF close for
 * the ctx's tradingStyle-derived TF (§8). Confirms smart-money entry with actual price/volume
 * follow-through built from Helius swaps.
 *
 * MVP: consumes an internal `memecoin.token.candle.closed` event carrying a mint. We compute
 * OHLCV via `buildTokenCandles` at request time. On thin/new tokens the confidence is capped
 * (§40.9 edge cases).
 *
 *   raw = 0.5 · slope_normalized + 0.5 · min(vol_ratio / 3, 1.0)
 *   score = raw × extension_penalty   (∈ [0.3, 1.0])
 *
 * CONDITIONAL skip: current-candle volume < 0.5 × 10-candle avg AND slope near 0 → dead candle.
 */
import type { DomainEvent } from '@tip/domain';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';
import { buildTokenCandles, type TokenCandle } from '../common/token-candle.js';

const KEY = 'memecoin.momentum';
const VERSION = 1;

const EVENT_TYPE = 'memecoin.token.candle.closed';

interface Payload { mint: string }

function slopePct(closes: readonly number[]): number {
  // Slope over the last 5 candles as % of the earliest close.
  const n = Math.min(5, closes.length);
  if (n < 2) return 0;
  const start = closes[closes.length - n]!;
  const end = closes[closes.length - 1]!;
  if (start <= 0) return 0;
  return (end - start) / start;
}

function normalizeSlope(pctPerCandle: number): number {
  // Cap at ±100% per candle → clamp to [-1, 1].
  return Math.max(-1, Math.min(1, pctPerCandle / 1.0));
}

function extensionPenalty(candles: readonly TokenCandle[]): number {
  const window = candles.slice(-20);
  if (window.length === 0) return 1.0;
  const low = Math.min(...window.map((c) => c.low));
  const current = candles[candles.length - 1]!.close;
  if (low <= 0) return 1.0;
  const extension = (current - low) / low;
  if (extension <= 0.3) return 1.0;
  // Diminish toward 0.3 as extension grows beyond +30%.
  return Math.max(0.3, 1.0 - Math.min(1, (extension - 0.3) / 1.0) * 0.7);
}

export const memecoinMomentumAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'CONDITIONAL',
  canHandle(event) {
    return event.type === EVENT_TYPE;
  },
  async analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null> {
    const { mint } = event.payload as Payload;
    const candles = await buildTokenCandles(ctx.db, mint, ctx.primaryTf, { limit: 60 });
    if (candles.length < 5) {
      // §40.9 edge case: minimal history; return NEUTRAL with low confidence + a flag.
      return {
        agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0.4,
        features: { mint, insufficientHistory: true, candles: candles.length },
      };
    }

    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volumeSol);
    const slope = normalizeSlope(slopePct(closes));

    const avgVol = volumes.length >= 10 ? volumes.slice(-10).reduce((s, v) => s + v, 0) / 10 : volumes.reduce((s, v) => s + v, 0) / volumes.length;
    const currentVol = volumes[volumes.length - 1]!;
    const volRatio = avgVol > 0 ? currentVol / avgVol : 1;

    // CONDITIONAL skip: nothing meaningful happened this candle.
    if (Math.abs(slope) < 0.02 && volRatio < 0.5) {
      return {
        agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0,
        features: { mint, skipReason: 'dead-candle', slope, volRatio },
        skipped: true,
      };
    }

    const raw = 0.5 * slope + 0.5 * Math.min(volRatio / 3, 1);
    const penalty = extensionPenalty(candles);
    const score = Math.max(0, Math.min(1, raw * penalty));

    // Confidence higher when slope + volume both point up.
    const bothConfirm = slope > 0 && volRatio > 1 ? 1 : 0.6;
    const confidence = Math.min(1, 0.4 + 0.6 * bothConfirm * Math.min(1, volRatio / 2));

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: score > 0 ? 'LONG' : 'NEUTRAL',
      score,
      confidence,
      features: { mint, slope, volRatio, extensionPenalty: penalty, candles: candles.length },
    };
  },
};

/** Exported for the runner to publish `memecoin.token.candle.closed` events. */
export const MEMECOIN_TOKEN_CANDLE_EVENT = EVENT_TYPE;
