/**
 * Signal Scoring Engine (§9, §33 rule 13 — deterministic). Combines per-agent normalized scores
 * into a weighted composite in [-1, +1], then thresholds into a direction bucket per domain.
 *
 * Only agents present in `agentWeights` contribute (absent = disabled per §7). Weights are
 * RENORMALIZED so two TradingAgents with different rosters produce comparable composites
 * (§7 rule 1 — "a TradingAgent running four of eight agents does not produce systematically
 * smaller scores than one running all eight").
 *
 * Non-directional agents (Regime, Risk, Token Risk) come through with `direction: 'NEUTRAL'`
 * and contribute their `score` if their key has a weight — Regime's `score` is the bias
 * (§40.3), which is intended contribution. Risk is a post-aggregation veto and by convention
 * has no weight entry, so it never contributes here.
 */
import type { AgentOutput } from './agent-interface.js';
import type { ScoringConfig } from './config.js';
import type { Domain } from './identity.js';

export type Direction =
  | 'STRONG_LONG' | 'LONG' | 'WEAK_LONG'
  | 'NEUTRAL'
  | 'WEAK_SHORT' | 'SHORT' | 'STRONG_SHORT';

export interface CompositeResult {
  compositeScore: number; // [-1, +1]
  direction: Direction;
  contributions: { agent: string; agentVersion: number; weight: number; contribution: number }[];
  // Descriptive stats useful to the confidence layer
  agentAgreement: number; // [0, 1]
  contributingCount: number;
}

/** Map a signed composite into a bucket using the TradingAgent's thresholds. */
export function directionFromComposite(score: number, thresholds: ScoringConfig['signalThresholds'], domain: Domain): Direction {
  if (score >= thresholds.strongLong) return 'STRONG_LONG';
  if (score >= thresholds.long) return 'LONG';
  if (score >= thresholds.weakLong) return 'WEAK_LONG';
  // Memecoin is long-only: everything below weakLong is NEUTRAL (§18 memecoin note).
  if (domain === 'memecoin') return 'NEUTRAL';
  if (thresholds.strongShort !== undefined && score <= thresholds.strongShort) return 'STRONG_SHORT';
  if (thresholds.short !== undefined && score <= thresholds.short) return 'SHORT';
  if (thresholds.weakShort !== undefined && score <= thresholds.weakShort) return 'WEAK_SHORT';
  return 'NEUTRAL';
}

/** Fraction of contributing agents whose signed score agrees with the composite's sign. */
function computeAgentAgreement(contribScores: number[], compositeSign: number): number {
  if (contribScores.length === 0 || compositeSign === 0) return 1;
  const agree = contribScores.filter((s) => Math.sign(s) === compositeSign || s === 0).length;
  return agree / contribScores.length;
}

export function composeSignal(
  outputs: readonly AgentOutput[],
  weights: ScoringConfig['agentWeights'],
  thresholds: ScoringConfig['signalThresholds'],
  domain: Domain,
): CompositeResult | null {
  // Skip agents that decided to skip this candle (CONDITIONAL dead-candle).
  const eligible = outputs.filter((o) => !o.skipped);
  if (eligible.length === 0) return null;

  // Only agents whose key is present in weights contribute (absent = disabled, §7).
  const usable = eligible.filter((o) => weights[o.agent] !== undefined && weights[o.agent]! > 0);
  if (usable.length === 0) return null;

  const totalWeight = usable.reduce((s, o) => s + weights[o.agent]!, 0);
  if (totalWeight === 0) return null;

  let composite = 0;
  const contributions: CompositeResult['contributions'] = [];
  for (const o of usable) {
    const w = weights[o.agent]! / totalWeight; // renormalized
    const contribution = w * o.score;
    composite += contribution;
    contributions.push({ agent: o.agent, agentVersion: o.agentVersion, weight: w, contribution });
  }
  // Clamp to [-1, +1] to survive rounding.
  composite = Math.max(-1, Math.min(1, composite));

  const compositeSign = composite === 0 ? 0 : composite > 0 ? 1 : -1;
  const agentAgreement = computeAgentAgreement(usable.map((o) => o.score), compositeSign);

  return {
    compositeScore: composite,
    direction: directionFromComposite(composite, thresholds, domain),
    contributions,
    agentAgreement,
    contributingCount: usable.length,
  };
}
