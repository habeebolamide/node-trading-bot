/**
 * Perp Positioning Agent (§40.6). CADENCE on `perp.positioning.polled` (from M1's Bybit
 * long-short account-ratio REST poller). Same contrarian shape as Funding — high L/S ratio
 * (crowded longs) → contrarian SHORT.
 *
 * The M1 poller doesn't persist a rolling window (it emits events only), so this agent's MVP
 * scoring uses the ratio directly with a symmetric shape around 1.0. Full 30-day-percentile
 * mode arrives when a `long_short_ratio` history table is added.
 */
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';

const KEY = 'perp.positioning';
const VERSION = 1;

interface Payload {
  symbol: string;
  buyRatio: string;
  sellRatio: string;
  longShortRatio: string;
  time: string;
}

/** Map an L/S ratio to a contrarian score in [-1, +1]. Ratio 1.0 → 0. */
export function scoreFromLSRatio(ratio: number): number {
  // Symmetric-in-log-space so 2.0 (long-crowded) mirrors 0.5 (short-crowded).
  if (ratio <= 0) return 0;
  const log = Math.log2(ratio);
  // Cap at |log| = 1 → ratio in [0.5, 2.0] saturates.
  return -Math.max(-1, Math.min(1, log));
}

export const perpPositioningAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'CADENCE',
  canHandle(event) { return event.type === EVENT_NAMES.PERP_POSITIONING_POLLED; },
  async analyze(event: DomainEvent, _ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as Payload;
    const ratio = Number(p.longShortRatio);
    if (!isFinite(ratio) || ratio <= 0) return null;
    const score = scoreFromLSRatio(ratio);
    const confidence = Math.min(0.9, 0.5 + Math.abs(Math.log2(ratio)) * 0.5);
    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: score > 0 ? 'LONG' : score < 0 ? 'SHORT' : 'NEUTRAL',
      score,
      confidence,
      features: { symbol: p.symbol, longShortRatio: ratio, buyRatio: p.buyRatio, sellRatio: p.sellRatio },
    };
  },
};
