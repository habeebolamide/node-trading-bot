import { describe, it, expect } from 'vitest';
import { computeConfidence, NO_BRAIN_EVIDENCE } from './confidence.js';
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

  it('historicalEvidence defaults to the no-Brain floor (was 0.5 at M4, now 0.25)', () => {
    // Only historicalEvidence contributes; expect 0.25 · 0.25 (weights sum to 1, no renormalization).
    const c = computeConfidence(
      { compositeScore: 0, agentAgreement: 0, dataQualityPenalties: 1 },
      defaultWeights,
    );
    expect(c).toBeCloseTo(0.25 * NO_BRAIN_EVIDENCE, 6);
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

describe('historicalEvidence (m5-historical-edge — no longer stubbed)', () => {
  const w = { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 };

  it('defaults to the no-Brain-evidence floor when the caller supplies none', () => {
    expect(NO_BRAIN_EVIDENCE).toBe(0.25);
    const withDefault = computeConfidence({ compositeScore: 0.6, agentAgreement: 1 }, w);
    const explicit = computeConfidence({ compositeScore: 0.6, agentAgreement: 1, historicalEvidence: NO_BRAIN_EVIDENCE }, w);
    expect(withDefault).toBeCloseTo(explicit, 12);
  });

  it('is no longer the old 0.5 stub — an empty Brain now lowers confidence', () => {
    const empty = computeConfidence({ compositeScore: 0.6, agentAgreement: 1 }, w);
    const oldStub = computeConfidence({ compositeScore: 0.6, agentAgreement: 1, historicalEvidence: 0.5 }, w);
    expect(empty).toBeLessThan(oldStub);
  });

  it('strong Brain evidence raises confidence over weak evidence, all else equal', () => {
    const strong = computeConfidence({ compositeScore: 0.6, agentAgreement: 0.8, historicalEvidence: 0.95 }, w);
    const weak = computeConfidence({ compositeScore: 0.6, agentAgreement: 0.8, historicalEvidence: 0.1 }, w);
    expect(strong).toBeGreaterThan(weak);
    // Moves by its configured weight, no more.
    expect(strong - weak).toBeCloseTo(0.25 * (0.95 - 0.1), 10);
  });

  it('clamps an out-of-range evidence value rather than propagating it', () => {
    const over = computeConfidence({ compositeScore: 0.5, agentAgreement: 1, historicalEvidence: 5 }, w);
    const one = computeConfidence({ compositeScore: 0.5, agentAgreement: 1, historicalEvidence: 1 }, w);
    expect(over).toBeCloseTo(one, 12);
  });
});
