import { describe, it, expect } from 'vitest';
import { brierScore, calibrationSummary, reliabilityDiagram } from './calibration.js';

describe('brierScore (Task 7)', () => {
  it('null on an empty sample', () => {
    expect(brierScore([])).toBeNull();
  });
  it('perfect prediction → 0', () => {
    const points = [{ confidence: 1, won: true }, { confidence: 0, won: false }];
    expect(brierScore(points)).toBe(0);
  });
  it('always-wrong → 1', () => {
    const points = [{ confidence: 1, won: false }, { confidence: 0, won: true }];
    expect(brierScore(points)).toBe(1);
  });
  it('always 0.5 on balanced set → 0.25 (the standard sanity anchor)', () => {
    const points = [{ confidence: 0.5, won: true }, { confidence: 0.5, won: false }];
    expect(brierScore(points)).toBe(0.25);
  });
});

describe('reliabilityDiagram', () => {
  it('places each point in one bin; confidence 1.0 lands in the top bin (right-closed)', () => {
    const rd = reliabilityDiagram([{ confidence: 1, won: true }], 10);
    expect(rd).toHaveLength(10);
    expect(rd[9]!.n).toBe(1);
  });
  it('a perfectly-calibrated set lands ON the diagonal', () => {
    // Make each bin's winRate == its midpoint by construction.
    const points: { confidence: number; won: boolean }[] = [];
    for (let i = 0; i < 10; i++) {
      const mid = (i + 0.5) / 10;
      // 10 points at this confidence: enough for a Wilson interval + a clean win rate = mid.
      const wins = Math.round(mid * 10);
      for (let k = 0; k < 10; k++) points.push({ confidence: mid, won: k < wins });
    }
    const rd = reliabilityDiagram(points);
    for (const b of rd) {
      if (b.winRate === null) continue;
      // On the diagonal within one bin's width.
      expect(Math.abs(b.winRate - b.midpoint)).toBeLessThan(0.06);
    }
  });
  it('systematically overconfident → win rates BELOW confidence', () => {
    // High confidence with only 50% wins.
    const points = Array.from({ length: 20 }, (_, k) => ({ confidence: 0.9, won: k < 10 }));
    const rd = reliabilityDiagram(points);
    const bin = rd.find((b) => b.n > 0)!;
    expect(bin.winRate!).toBeLessThan(bin.midpoint);
  });
  it('empty bins report null winRate', () => {
    const rd = reliabilityDiagram([{ confidence: 0.5, won: true }]);
    expect(rd[0]!.winRate).toBeNull();
    expect(rd[5]!.winRate).toBe(1);
  });
});

describe('calibrationSummary', () => {
  it('returns null brier + n=0 on empty', () => {
    const s = calibrationSummary([]);
    expect(s.brier).toBeNull();
    expect(s.n).toBe(0);
  });
  it('ECE is n-weighted mean |mid - winRate| across populated bins', () => {
    // One bin at midpoint 0.55 with winRate 0.75 → |0.55 − 0.75| × 1 = 0.20.
    const points = Array.from({ length: 4 }, (_, k) => ({ confidence: 0.55, won: k < 3 }));
    const s = calibrationSummary(points);
    expect(s.ece!).toBeCloseTo(0.2, 2);
  });
});
