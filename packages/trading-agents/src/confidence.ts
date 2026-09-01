/**
 * Confidence (Task 6): weighted sum of four sub-metrics, each in [0, 1]:
 *
 *   confidence = w1·signalStrength + w2·agentAgreement + w3·historicalEvidence + w4·dataQuality
 *
 * Weights come from the TradingAgent's ScoringConfig.confidenceWeights (§8 added-fields).
 * Defaults are Task-6's 0.30 / 0.30 / 0.25 / 0.15 — enforced in `validateScoringConfig`.
 *
 * `historicalEvidence` is a STUB at M4 (returns 0.5 — "unknown") until BrainSetupMemory (M5)
 * lands; the Historical Edge feature does the real lookup then. `dataQuality` is 1 minus
 * accumulated penalties (stale feeds via M1 FeedMonitor, missing agents, thin liquidity).
 */
import type { ScoringConfig } from './config.js';

export interface ConfidenceInputs {
  compositeScore: number; // signalStrength = |compositeScore|
  agentAgreement: number; // fraction of contributing agents whose sign matches the composite
  historicalEvidence?: number; // 0.5 stub at M4 until M5 wires BrainSetupMemory
  dataQualityPenalties?: number; // sum of [0,1] penalty weights; dataQuality = clamp(1 - Σ)
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export function computeConfidence(inputs: ConfidenceInputs, weights: ScoringConfig['confidenceWeights']): number {
  const signalStrength = clamp01(Math.abs(inputs.compositeScore));
  const agentAgreement = clamp01(inputs.agentAgreement);
  const historicalEvidence = clamp01(inputs.historicalEvidence ?? 0.5); // M4 stub
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
