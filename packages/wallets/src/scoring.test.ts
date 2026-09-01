import { describe, it, expect } from 'vitest';
import { scoreUniverse, type Weights } from './scoring.js';
import type { RawMetrics } from './metrics.js';

const raw = (profitability: number): RawMetrics => ({
  profitability, winRate: 0.5, earlyEntry: 0, consistency: 0.5, specialization: 1, tradeQuality: 1, corroboration: 0, n: 20,
});

const onlyProfit: Weights = { profitability: 1, winRate: 0, earlyEntry: 0, consistency: 0, specialization: 0, tradeQuality: 0, corroboration: 0 };

describe('scoreUniverse', () => {
  it('scores by percentile of the weighted metric across the universe', () => {
    const m = new Map([['a', raw(1)], ['b', raw(2)], ['c', raw(3)]]);
    const scored = scoreUniverse(m, onlyProfit);
    const byId = Object.fromEntries(scored.map((s) => [s.walletId, s.score]));
    expect(byId['c']).toBe(100); // highest profitability → top percentile
    expect(byId['a']).toBeLessThan(byId['b']!);
    expect(byId['b']).toBeLessThan(byId['c']!);
  });

  it('renormalizes weights that do not sum to 1 (score stays in [0,100])', () => {
    const doubled: Weights = { ...onlyProfit, profitability: 2 };
    const scored = scoreUniverse(new Map([['a', raw(1)], ['b', raw(2)]]), doubled);
    for (const s of scored) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it('single-wallet universe → percentile 100 on every metric', () => {
    const scored = scoreUniverse(new Map([['solo', raw(5)]]), onlyProfit);
    expect(scored[0]!.score).toBe(100);
  });

  it('empty universe → empty result', () => {
    expect(scoreUniverse(new Map(), onlyProfit)).toEqual([]);
  });
});
