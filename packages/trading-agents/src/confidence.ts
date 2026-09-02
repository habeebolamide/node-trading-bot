/**
 * Confidence (Task 6): weighted sum of four sub-metrics, each in [0, 1]:
 *
 *   confidence = w1·signalStrength + w2·agentAgreement + w3·historicalEvidence + w4·dataQuality
 *
 * Weights come from the TradingAgent's ScoringConfig.confidenceWeights (§8 added-fields).
 * Defaults are Task-6's 0.30 / 0.30 / 0.25 / 0.15 — enforced in `validateScoringConfig`.
 *
 * `historicalEvidence` comes from the Historical Edge feature's Brain read (m5-historical-edge,
 * `historicalEvidenceFrom(effectiveN, ciWidth)`) — Task 6's `f(effective-n, Wilson width)`, low
 * when INSUFFICIENT. It is passed in rather than computed here so this module stays pure and
 * DB-free. When the caller has no Brain read at all (no features assembled), the INSUFFICIENT
 * floor of 0.25 applies — see `INSUFFICIENT_EVIDENCE_FLOOR` in `@tip/brain`; the value is
 * duplicated as a literal below only to avoid a dependency edge from trading-agents → brain.
 *
 * `dataQuality` is 1 minus accumulated penalties (stale feeds via M1 FeedMonitor, missing
 * agents, thin liquidity).
 */
import type { ScoringConfig } from './config.js';

export interface ConfidenceInputs {
  compositeScore: number; // signalStrength = |compositeScore|
  agentAgreement: number; // fraction of contributing agents whose sign matches the composite
  /** From the Historical Edge feature's Brain read. Omitted → the INSUFFICIENT floor. */
  historicalEvidence?: number;
  dataQualityPenalties?: number; // sum of [0,1] penalty weights; dataQuality = clamp(1 - Σ)
}

/**
 * Mirror of `INSUFFICIENT_EVIDENCE_FLOOR` in `@tip/brain`. Kept as a literal so this package
 * does not take a dependency on the Brain just for a constant; asserted equal in the tests.
 */
export const NO_BRAIN_EVIDENCE = 0.25;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export function computeConfidence(inputs: ConfidenceInputs, weights: ScoringConfig['confidenceWeights']): number {
  const signalStrength = clamp01(Math.abs(inputs.compositeScore));
  const agentAgreement = clamp01(inputs.agentAgreement);
  const historicalEvidence = clamp01(inputs.historicalEvidence ?? NO_BRAIN_EVIDENCE);
  const dataQuality = clamp01(1 - (inputs.dataQualityPenalties ?? 0));

  // Renormalize weights defensively so no config accidentally produces confidence > 1 or drift.
  const total =
    weights.signalStrength + weights.agentAgreement + weights.historicalEvidence + weights.dataQuality;
  if (total <= 0) return 0;
  const w = {
    signalStrength: weights.signalStrength / total,
    agentAgreement: weights.agentAgreement / total,
    historicalEvidence: weights.historicalEvidence / total,
    dataQuality: weights.dataQuality / total,
  };

  return (
    w.signalStrength * signalStrength +
    w.agentAgreement * agentAgreement +
    w.historicalEvidence * historicalEvidence +
    w.dataQuality * dataQuality
  );
}
