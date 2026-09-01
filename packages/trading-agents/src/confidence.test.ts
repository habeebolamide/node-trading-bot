import { describe, it, expect } from 'vitest';
import { computeConfidence } from './confidence.js';
import type { ScoringConfig } from './config.js';

const defaultWeights: ScoringConfig['confidenceWeights'] = {
  signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15,
};

describe('computeConfidence', () => {
  it('with all sub-metrics at 1 and default weights, returns 1', () => {
    const c = computeConfidence(
      { compositeScore: 1, agentAgreement: 1, historicalEvidence: 1, dataQualityPenalties: 0 },
      defaultWeights,
    );
    expect(c).toBeCloseTo(1, 6);
  });

  it('with all at 0, returns 0', () => {
    const c = computeConfidence(
      { compositeScore: 0, agentAgreement: 0, historicalEvidence: 0, dataQualityPenalties: 1 },
      defaultWeights,
    );
    expect(c).toBeCloseTo(0, 6);
  });

  it('historicalEvidence defaults to 0.5 (M4 stub)', () => {
    // Only historicalEvidence contributes; expect 0.25 · 0.5 = 0.125 (weights renormalize but not needed since sum=1)
    const c = computeConfidence(
      { compositeScore: 0, agentAgreement: 0, dataQualityPenalties: 1 },
      defaultWeights,
    );
    expect(c).toBeCloseTo(0.25 * 0.5, 6);
  });

  it('renormalizes weights that do not sum to 1', () => {
    const c = computeConfidence(
      { compositeScore: 1, agentAgreement: 1, historicalEvidence: 1, dataQualityPenalties: 0 },
      { signalStrength: 2, agentAgreement: 2, historicalEvidence: 2, dataQuality: 2 },
    );
    expect(c).toBeCloseTo(1, 6);
  });

  it('composite is signalStrength = |compositeScore| (sign doesn\'t matter for confidence)', () => {
    const a = computeConfidence({ compositeScore: 0.8, agentAgreement: 0 }, defaultWeights);
    const b = computeConfidence({ compositeScore: -0.8, agentAgreement: 0 }, defaultWeights);
    expect(a).toBeCloseTo(b, 6);
  });

  it('dataQuality = clamp(1 - penalties)', () => {
    const c1 = computeConfidence({ compositeScore: 0, agentAgreement: 0, historicalEvidence: 0, dataQualityPenalties: 0.5 }, defaultWeights);
    const c2 = computeConfidence({ compositeScore: 0, agentAgreement: 0, historicalEvidence: 0, dataQualityPenalties: 2 }, defaultWeights);
    expect(c1).toBeCloseTo(0.15 * 0.5, 6);
    expect(c2).toBeCloseTo(0, 6); // clamped at 0
  });
});
