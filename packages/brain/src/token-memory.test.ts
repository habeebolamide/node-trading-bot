import { describe, it, expect } from 'vitest';
import {
  percentileOf, tokenScore, tokenOutcomes, MIN_UNIVERSE_FOR_PERCENTILE,
  type TokenUniverse,
} from './token-memory.js';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

const universe: TokenUniverse = {
  liquidityUsd: range(20).map((x) => x * 1000),
  ageMinutes: range(20).map((x) => x * 60),
  top10HolderPct: range(20).map((x) => x / 100),
  volume24hUsd: range(20).map((x) => x * 500),
};

describe('percentileOf', () => {
  it('is the fraction of the universe at or below the value', () => {
    expect(percentileOf(5, range(10))).toBeCloseTo(0.5, 10);
    expect(percentileOf(10, range(10))).toBe(1);
    expect(percentileOf(0, range(10))).toBe(0);
  });
  it('returns null against a universe thinner than the floor — never a fabricated percentile', () => {
    expect(percentileOf(5, range(MIN_UNIVERSE_FOR_PERCENTILE - 1))).toBeNull();
    expect(percentileOf(5, [])).toBeNull();
  });
  it('accepts exactly the floor', () => {
    expect(percentileOf(5, range(MIN_UNIVERSE_FOR_PERCENTILE))).not.toBeNull();
  });
});

describe('tokenScore (Task 6 inputs)', () => {
  it('null when no sub-metric is available — "unknown" is distinguishable from "bad"', () => {
    expect(tokenScore({}, universe)).toBeNull();
  });

  it('null when the universe is too thin to percentile against', () => {
    const thin: TokenUniverse = { liquidityUsd: [1, 2], ageMinutes: [], top10HolderPct: [], volume24hUsd: [] };
    expect(tokenScore({ liquidityUsd: 1 }, thin)).toBeNull();
  });

  it('scores on the sub-metrics that ARE available (partial coverage is not a failure)', () => {
    const s = tokenScore({ liquidityUsd: 20_000 }, universe);
    expect(s).toBeCloseTo(1, 10); // top of the liquidity universe
  });

  it('more liquidity scores higher', () => {
    expect(tokenScore({ liquidityUsd: 18_000 }, universe)!).toBeGreaterThan(
      tokenScore({ liquidityUsd: 2_000 }, universe)!,
    );
  });

  it('holder concentration is INVERTED — a less concentrated token scores higher', () => {
    const concentrated = tokenScore({ top10HolderPct: 0.19 }, universe)!;
    const spread = tokenScore({ top10HolderPct: 0.02 }, universe)!;
    expect(spread).toBeGreaterThan(concentrated);
  });

  it('averages the available percentiles equally', () => {
    const s = tokenScore({ liquidityUsd: 20_000, volume24hUsd: 10_000 }, universe)!;
    expect(s).toBeCloseTo(1, 10);
    const mixed = tokenScore({ liquidityUsd: 20_000, volume24hUsd: 500 }, universe)!;
    expect(mixed).toBeCloseTo((1 + 0.05) / 2, 10);
  });

  it('stays within [0,1]', () => {
    for (const liq of [0, 500, 20_000, 1e9]) {
      const s = tokenScore({ liquidityUsd: liq }, universe)!;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('takes NO safety input — Token Risk (§40.13) is a hard gate, not a soft score', () => {
    // A safety-shaped field is simply ignored: it cannot dilute into a merely-low score.
    const withSafety = tokenScore({ liquidityUsd: 20_000, mintAuthorityLive: true } as never, universe);
    expect(withSafety).toBe(tokenScore({ liquidityUsd: 20_000 }, universe));
  });
});

describe('tokenOutcomes', () => {
  it('empty sample yields nulls, not a fabricated rate', () => {
    const o = tokenOutcomes(0, 0, null);
    expect(o.winRate).toBeNull();
    expect(o.wilsonLower).toBeNull();
  });
  it('uses the same Wilson helper as Setup Memory (bounds bracket the rate)', () => {
    const o = tokenOutcomes(7, 10, 0.3);
    expect(o.winRate).toBeCloseTo(0.7, 10);
    expect(o.wilsonLower!).toBeLessThan(0.7);
    expect(o.wilsonUpper!).toBeGreaterThan(0.7);
  });
  it('carries the median return through untouched', () => {
    expect(tokenOutcomes(5, 10, -0.42).medianReturn).toBe(-0.42);
  });
});
