/**
 * Memecoin Token Quality Agent (§40.10). EVENT on `token.profile.updated`. Unipolar (LONG or 0,
 * never negative) — a "high quality" token contributes bullishly, a "low quality" one contributes
 * nothing. Composite weight 10% (Part II §9). SOFT quality, distinct from Token Risk (§40.13)
 * which is a HARD veto.
 *
 * MVP inputs (from the event payload the Helius/token profile pipeline supplies):
 *   liquidityUsd, ageMinutes, top10HolderPct.  If any sub-feature is missing, confidence caps
 *   at 0.6 (§40.10 edge case).
 */
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';

const KEY = 'memecoin.token_quality';
const VERSION = 1;

interface Payload {
  mint: string;
  liquidityUsd?: number;
  ageMinutes?: number;
  top10HolderPct?: number; // 0..100
}

// Rough MVP normalizations — replace with universe percentile once TokenMetrics stats exist.
const norm01 = (x: number): number => Math.max(0, Math.min(1, x));
function liquidityScore(usd: number | undefined): number | null {
  if (usd === undefined || usd < 0) return null;
  return norm01(usd / 250_000); // 250k USD saturates
}
function ageScore(minutes: number | undefined): number | null {
  if (minutes === undefined || minutes < 0) return null;
  const capped = Math.min(minutes, 24 * 60);
  return norm01(capped / (24 * 60));
}
function concentrationScore(pct: number | undefined): number | null {
  if (pct === undefined || pct < 0) return null;
  // top-10 holding a smaller fraction = better; invert.
  return norm01(1 - pct / 100);
}

export const memecoinTokenQualityAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'EVENT',
  canHandle(event) {
    return event.type === EVENT_NAMES.TOKEN_PROFILE_UPDATED;
  },
  async analyze(event: DomainEvent, _ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as Payload;
    if (!p?.mint) return null;

    const liq = liquidityScore(p.liquidityUsd);
    const age = ageScore(p.ageMinutes);
    const conc = concentrationScore(p.top10HolderPct);

    // Weighted average of available sub-features; skip missing ones by redistributing.
    const parts: { weight: number; value: number }[] = [];
    if (liq !== null) parts.push({ weight: 0.5, value: liq });
    if (age !== null) parts.push({ weight: 0.3, value: age });
    if (conc !== null) parts.push({ weight: 0.2, value: conc });
    if (parts.length === 0) return null;

    const totalWeight = parts.reduce((s, p_) => s + p_.weight, 0);
    const score = parts.reduce((s, p_) => s + (p_.weight / totalWeight) * p_.value, 0);

    // If we're missing a sub-feature, cap confidence at 0.6 per §40.10.
    const missingCount = 3 - parts.length;
    const baseConfidence = 0.85;
    const confidence = missingCount > 0 ? Math.min(0.6, baseConfidence) : baseConfidence;

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: score > 0 ? 'LONG' : 'NEUTRAL',
      score,
      confidence,
      features: {
        mint: p.mint,
        liquidityUsd: p.liquidityUsd ?? null,
        ageMinutes: p.ageMinutes ?? null,
        top10HolderPct: p.top10HolderPct ?? null,
        subScores: { liquidity: liq, age, concentration: conc },
      },
    };
  },
};
