import { describe, it, expect } from 'vitest';
import { ValidationError } from '@tip/domain';
import { confidenceToZ, recencyWeight, weightedMedian, wilsonInterval } from './stats.js';

describe('confidenceToZ', () => {
  it('returns the tabulated z for supported levels', () => {
    expect(confidenceToZ(0.95)).toBeCloseTo(1.96, 4);
    expect(confidenceToZ(0.9)).toBeCloseTo(1.6449, 4);
    expect(confidenceToZ(0.99)).toBeCloseTo(2.5758, 4);
  });
  it('throws rather than silently approximating an unsupported level', () => {
    expect(() => confidenceToZ(0.975)).toThrow(ValidationError);
  });
});

describe('wilsonInterval (§41)', () => {
  it('n = 0 returns the maximally-uninformative interval', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1, center: 0.5 });
  });

  it('negative n is treated the same as zero (defensive)', () => {
    expect(wilsonInterval(0, -5)).toEqual({ lower: 0, upper: 1, center: 0.5 });
  });

  it('all-wins: upper pinned at 1, lower strictly below 1 (never claims certainty)', () => {
    const ci = wilsonInterval(10, 10);
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.lower).toBeLessThan(1);
  });

  it('all-losses: lower pinned at 0, upper strictly above 0', () => {
    const ci = wilsonInterval(0, 10);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(ci.upper).toBeLessThan(1);
  });

  it('bounds always bracket the center and stay within [0,1]', () => {
    for (const [w, n] of [[1, 3], [5, 10], [7, 9], [300, 500]] as const) {
      const ci = wilsonInterval(w, n);
      expect(ci.lower).toBeLessThanOrEqual(ci.center);
      expect(ci.center).toBeLessThanOrEqual(ci.upper);
      expect(ci.lower).toBeGreaterThanOrEqual(0);
      expect(ci.upper).toBeLessThanOrEqual(1);
    }
  });

  it('a larger sample at the same win rate produces a narrower interval', () => {
    const small = wilsonInterval(6, 10);
    const large = wilsonInterval(600, 1000);
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
  });

  it('accepts FRACTIONAL effective counts (Part II §8 — the whole point)', () => {
    const ci = wilsonInterval(7.31, 11.42);
    expect(Number.isFinite(ci.lower)).toBe(true);
    expect(ci.center).toBeGreaterThan(0.5);
  });

  it('known value: 6/10 at 95%, hand-derived against §41\'s formula', () => {
    // p=0.6, n=10, z=1.96, z²=3.8416
    // denominator = 1 + 3.8416/10                       = 1.38416
    // center      = (0.6 + 3.8416/20) / 1.38416         = 0.5722344…
    // margin      = 1.96·√((0.24 + 0.09604)/10) / denom = 0.2595784…
    const ci = wilsonInterval(6, 10);
    expect(ci.center).toBeCloseTo(0.5722460, 6);
    expect(ci.lower).toBeCloseTo(0.3126695, 6);
    expect(ci.upper).toBeCloseTo(0.8318224, 6);
  });

  it('decayed effective-n reports MORE uncertainty than the raw count would', () => {
    // Part II §8's stated failure mode: 1,020 raw occurrences of which only ~20 are fresh must
    // report a CI closer to what 20 samples justify, not 1,020.
    const raw = wilsonInterval(612, 1020);
    const effective = wilsonInterval(12, 20);
    expect(effective.upper - effective.lower).toBeGreaterThan(raw.upper - raw.lower);
  });
});

describe('recencyWeight (Task 6)', () => {
  it('age 0 weighs 1', () => {
    expect(recencyWeight(0, 30)).toBe(1);
  });
  it('exactly one half-life weighs exactly 0.5', () => {
    expect(recencyWeight(30, 30)).toBe(0.5);
    expect(recencyWeight(90, 90)).toBe(0.5);
  });
  it('two half-lives weigh 0.25', () => {
    expect(recencyWeight(60, 30)).toBeCloseTo(0.25, 12);
  });
  it('decays monotonically and never reaches zero', () => {
    expect(recencyWeight(365, 30)).toBeGreaterThan(0);
    expect(recencyWeight(365, 30)).toBeLessThan(recencyWeight(200, 30));
  });
  it('rejects a non-positive half-life', () => {
    expect(() => recencyWeight(1, 0)).toThrow(ValidationError);
  });
});

describe('weightedMedian (§41)', () => {
  it('null on an empty sample', () => {
    expect(weightedMedian([])).toBeNull();
  });
  it('null when every weight has decayed to zero', () => {
    expect(weightedMedian([{ value: 1, weight: 0 }, { value: 2, weight: 0 }])).toBeNull();
  });
  it('single item returns its value', () => {
    expect(weightedMedian([{ value: 0.42, weight: 0.3 }])).toBe(0.42);
  });
  it('equal weights reproduce the ordinary median position', () => {
    const items = [3, 1, 2].map((value) => ({ value, weight: 1 }));
    expect(weightedMedian(items)).toBe(2);
  });
  it('weight skew pulls the median toward the heavy value', () => {
    const items = [
      { value: -0.5, weight: 0.01 },
      { value: -0.4, weight: 0.01 },
      { value: 0.9, weight: 10 },
    ];
    expect(weightedMedian(items)).toBe(0.9);
  });
  it('does not mutate the caller\'s array', () => {
    const items = [{ value: 5, weight: 1 }, { value: 1, weight: 1 }];
    weightedMedian(items);
    expect(items[0]!.value).toBe(5);
  });
});
