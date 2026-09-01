import { describe, it, expect } from 'vitest';
import { betaBinomialShrunk, percentileRank, median } from './stats.js';

describe('betaBinomialShrunk (priors α₀=4, β₀=6 → base 0.4)', () => {
  it('a tiny perfect sample does NOT outrank a deep good one', () => {
    const twoForTwo = betaBinomialShrunk(2, 2, 4, 6); // 6/12 = 0.5
    const deep = betaBinomialShrunk(350, 500, 4, 6); // 354/510 ≈ 0.694
    expect(twoForTwo).toBeLessThan(deep);
  });
  it('n=0 returns the prior mean (base rate)', () => {
    expect(betaBinomialShrunk(0, 0, 4, 6)).toBeCloseTo(0.4, 6);
  });
  it('is monotonic in wins at fixed n', () => {
    expect(betaBinomialShrunk(5, 10, 4, 6)).toBeGreaterThan(betaBinomialShrunk(3, 10, 4, 6));
  });
});

describe('percentileRank', () => {
  it('max → 100, and everything ≤ max', () => {
    expect(percentileRank(10, [1, 2, 5, 10])).toBe(100);
    expect(percentileRank(5, [1, 2, 5, 10])).toBe(75);
  });
  it('neutral 50 on an empty population', () => {
    expect(percentileRank(3, [])).toBe(50);
  });
  it('single-value population → 100', () => {
    expect(percentileRank(7, [7])).toBe(100);
  });
});

describe('median', () => {
  it('odd, even, empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
