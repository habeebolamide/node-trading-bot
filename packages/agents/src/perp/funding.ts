/**
 * Perp Funding Agent (§40.5). CADENCE on primary-TF close. Reads the current funding rate for
 * the symbol and computes its percentile within a rolling 30-day distribution → symmetric
 * contrarian score.
 *
 *   percentile > 90 → strong contrarian SHORT (-0.7 to -1.0)
 *   percentile > 75 → moderate contrarian SHORT (-0.3 to -0.7)
 *   25..75          → NEUTRAL
 *   percentile < 25 → moderate contrarian LONG (+0.3 to +0.7)
 *   percentile < 10 → strong contrarian LONG (+0.7 to +1.0)
 *
 * Insufficient 30d history caps confidence at 0.5 (§40.5 edge case).
 */
import { and, asc, eq, gte, lte, desc } from 'drizzle-orm';
import type { DomainEvent } from '@tip/domain';
import { fundingRate } from '@tip/database';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';
import { percentile } from './indicators.js';

const KEY = 'perp.funding';
const VERSION = 1;
const DAY_MS = 24 * 60 * 60_000;

interface KlinePayload { symbol: string; timeframe: string; closeTime: string }

function scoreFromPercentile(pct: number): number {
  if (pct > 0.9) return -(0.7 + Math.min(0.3, (pct - 0.9) * 3));
  if (pct > 0.75) return -(0.3 + (pct - 0.75) * 2.67); // scales to 0.7 at 0.9
  if (pct < 0.1) return 0.7 + Math.min(0.3, (0.1 - pct) * 3);
  if (pct < 0.25) return 0.3 + (0.25 - pct) * 2.67;
  return 0;
}

export const perpFundingAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'CADENCE',
  canHandle(event) { return event.type === EVENT_NAMES.PERP_KLINE_CLOSED; },
  async analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as KlinePayload;
    if (p.timeframe !== ctx.primaryTf) return null;
    const closeTime = new Date(p.closeTime);

    // Latest funding rate at or before close time.
    const latest = await ctx.db
      .select({ rate: fundingRate.rate, fundingTime: fundingRate.fundingTime })
      .from(fundingRate)
      .where(and(eq(fundingRate.symbol, p.symbol), lte(fundingRate.fundingTime, closeTime)))
      .orderBy(desc(fundingRate.fundingTime))
      .limit(1);
    if (latest.length === 0) return null;
    const currentRate = Number(latest[0]!.rate);

    // Rolling 30-day distribution.
    const historyStart = new Date(closeTime.getTime() - 30 * DAY_MS);
    const history = await ctx.db
      .select({ rate: fundingRate.rate })
      .from(fundingRate)
      .where(and(eq(fundingRate.symbol, p.symbol), gte(fundingRate.fundingTime, historyStart), lte(fundingRate.fundingTime, closeTime)))
      .orderBy(asc(fundingRate.fundingTime));

    const rates = history.map((r) => Number(r.rate));
    const enoughHistory = rates.length >= 30; // 30d × ~3/day = ~90; 30 is a soft floor
    const pct = enoughHistory ? percentile(currentRate, rates) : null;

    if (pct === null) {
      return {
        agent: KEY, agentVersion: VERSION, direction: 'NEUTRAL', score: 0, confidence: 0.5,
        features: { symbol: p.symbol, currentRate, historyCount: rates.length, insufficientHistory: true },
      };
    }

    const score = scoreFromPercentile(pct);
    const confidence = Math.min(0.95, 0.5 + Math.abs(pct - 0.5) * 0.9);

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: score > 0 ? 'LONG' : score < 0 ? 'SHORT' : 'NEUTRAL',
      score,
      confidence,
      features: { symbol: p.symbol, currentRate, percentile30d: pct, historyCount: rates.length },
    };
  },
};

export { scoreFromPercentile as _fundingScoreFromPercentile }; // for tests
