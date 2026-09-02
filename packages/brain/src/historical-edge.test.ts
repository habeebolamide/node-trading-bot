import { describe, it, expect } from 'vitest';
import { edgeScore, historicalEvidenceFrom, INSUFFICIENT_EVIDENCE_FLOOR } from './historical-edge.js';

describe('edgeScore (§40.16 step 4)', () => {
  it('win rate above 50% AMPLIFIES (positive), below 50% counters (negative)', () => {
    expect(edgeScore(0.7, 0.2, 0)).toBeGreaterThan(0);
    expect(edgeScore(0.3, 0.2, 0)).toBeLessThan(0);
  });

  it('a coin-flip win rate contributes nothing regardless of precision', () => {
    expect(edgeScore(0.5, 0.05, 0)).toBe(0);
  });

  it('a narrow CI outscores a wide one at the same win rate', () => {
    expect(edgeScore(0.7, 0.1, 0)).toBeGreaterThan(edgeScore(0.7, 0.6, 0));
  });

  it('a CI wider than 1 contributes nothing (clamped, never negative)', () => {
    expect(edgeScore(0.9, 1.4, 0)).toBe(0);
  });

  it('each backoff rung halves the contribution', () => {
    const exact = edgeScore(0.8, 0.2, 0);
    expect(edgeScore(0.8, 0.2, 1)).toBeCloseTo(exact / 2, 12);
    expect(edgeScore(0.8, 0.2, 2)).toBeCloseTo(exact / 4, 12);
  });

  it('a global-base-rate fallback contributes near-zero (§40.16 edge case)', () => {
    expect(Math.abs(edgeScore(0.8, 0.2, 5))).toBeLessThan(0.02);  // memecoin global
    expect(Math.abs(edgeScore(0.8, 0.2, 8))).toBeLessThan(0.003); // perp global
  });

  it('stays within [-1, +1] even at maximal win rate and precision', () => {
    expect(edgeScore(1, 0, 0)).toBeLessThanOrEqual(1);
    expect(edgeScore(0, 0, 0)).toBeGreaterThanOrEqual(-1);
  });
});

describe('historicalEvidenceFrom (Task 6)', () => {
  it('returns the INSUFFICIENT floor when there is no interval at all', () => {
    expect(historicalEvidenceFrom(0, null)).toBe(INSUFFICIENT_EVIDENCE_FLOOR);
    expect(historicalEvidenceFrom(500, null)).toBe(INSUFFICIENT_EVIDENCE_FLOOR);
  });

  it('the floor is 0.25 — not 0, so an empty Brain does not cap every signal near 0.75', () => {
    expect(INSUFFICIENT_EVIDENCE_FLOOR).toBe(0.25);
  });

  it('rises with effective-n at fixed precision, saturating at 3× the trust floor', () => {
    const at10 = historicalEvidenceFrom(10, 0.2);
    const at20 = historicalEvidenceFrom(20, 0.2);
    const at30 = historicalEvidenceFrom(30, 0.2);
    const at100 = historicalEvidenceFrom(100, 0.2);
    expect(at20).toBeGreaterThan(at10);
    expect(at30).toBeGreaterThan(at20);
    expect(at100).toBeCloseTo(at30, 12); // saturated
  });

  it('falls as the interval widens at fixed sample size', () => {
    expect(historicalEvidenceFrom(30, 0.6)).toBeLessThan(historicalEvidenceFrom(30, 0.1));
  });

  it('a useless interval (width ≥ 1) yields zero evidence', () => {
    expect(historicalEvidenceFrom(30, 1)).toBe(0);
    expect(historicalEvidenceFrom(30, 1.5)).toBe(0);
  });

  it('always lands in [0, 1]', () => {
    for (const n of [0, 5, 10, 50, 1000]) {
      for (const w of [0, 0.3, 0.9, 1]) {
        const v = historicalEvidenceFrom(n, w);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
