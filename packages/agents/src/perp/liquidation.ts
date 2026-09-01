/**
 * Perp Liquidation Agent (§40.4). EVENT + CADENCE roll-up. Consumes
 * `perp.liquidation.detected` events, aggregates over a rolling window per primary-TF, and
 * produces a contrarian score: long liquidations → LONG signal (cascade near bottom), short
 * liquidations → SHORT (cascade near top). Pure intensity spike (no imbalance) → NEUTRAL with a
 * risk flag for the Risk Agent to consume.
 *
 * MVP: consumes the event's own imbalance/intensity if the payload provides them; else falls
 * back to the raw single-event evaluation. A CADENCE roll-up (aggregating events across the
 * last N primary-TF minutes) is a follow-up refinement.
 */
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';

const KEY = 'perp.liquidation';
const VERSION = 1;

interface LiqPayload {
  symbol: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  time: string;
  // Optional roll-up fields when the ingestor supplies them:
  imbalance?: number; // (long − short) / (long + short) in the rolling window
  intensityRatio?: number; // rolling volume / 30-candle avg
}

export const perpLiquidationAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'EVENT',
  canHandle(event) { return event.type === EVENT_NAMES.PERP_LIQUIDATION_DETECTED; },
  async analyze(event: DomainEvent, _ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as LiqPayload;
    if (!p?.symbol) return null;

    let imbalance = p.imbalance;
    let intensity = p.intensityRatio;
    // Fallback for single-event evaluation.
    if (imbalance === undefined) {
      imbalance = p.side === 'SELL' ? +1 : -1; // SELL liqs = long positions being liquidated → contrarian long → +imbalance
    }
    if (intensity === undefined) intensity = 1;

    if (Math.abs(imbalance) < 0.5 && intensity > 3) {
      return {
        agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0.5,
        features: { symbol: p.symbol, riskFlag: 'HIGH_LIQ_SPIKE', imbalance, intensity },
      };
    }
    if (Math.abs(imbalance) < 0.5 || intensity < 1) {
      return { agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0.2, features: { symbol: p.symbol, imbalance, intensity } };
    }

    const score = imbalance * Math.min(intensity / 3, 1);
    const confidence = Math.min(1, Math.abs(imbalance) * Math.min(intensity / 3, 1));

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: score > 0 ? 'LONG' : 'SHORT',
      score,
      confidence,
      features: { symbol: p.symbol, imbalance, intensity, side: p.side },
    };
  },
};
