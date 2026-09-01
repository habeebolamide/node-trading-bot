import { describe, it, expect } from 'vitest';
import { findCoBuyClusters, type BuyEvent } from './co-buy.js';
import { quantile, analyzeBatchingWindow, analyzeProfitLadder, analyzeFreshness } from './seed-metrics.js';

const buy = (wallet: string, mint: string, tSec: number): BuyEvent => ({
  wallet, mint, blockTime: tSec * 1000, amountSol: 1, tokenAmount: 1000,
});

describe('findCoBuyClusters', () => {
  it('groups ≥3 distinct wallets buying one mint within a session', () => {
    const clusters = findCoBuyClusters(
      [buy('a', 'M', 0), buy('b', 'M', 3), buy('c', 'M', 6)],
      { sessionGapMs: 60_000, minWallets: 3 },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.wallets.sort()).toEqual(['a', 'b', 'c']);
    expect(clusters[0]!.spanMs).toBe(6000);
  });

  it('splits bursts separated by more than the session gap', () => {
    const clusters = findCoBuyClusters(
      [buy('a', 'M', 0), buy('b', 'M', 1), buy('c', 'M', 2), buy('a', 'M', 1000), buy('b', 'M', 1001), buy('c', 'M', 1002)],
      { sessionGapMs: 60_000, minWallets: 3 },
    );
    expect(clusters).toHaveLength(2);
  });

  it('ignores bursts below the minimum wallet count', () => {
    expect(findCoBuyClusters([buy('a', 'M', 0), buy('b', 'M', 1)], { minWallets: 3 })).toHaveLength(0);
  });
});

describe('quantile + batching window', () => {
  it('quantile interpolates', () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 6);
  });
  it('recommends the p90 span', () => {
    const r = analyzeBatchingWindow([1000, 2000, 3000, 4000, 100000]);
    expect(r.n).toBe(5);
    expect(r.recommendedMs).toBe(r.p90);
  });
});

describe('profit ladder', () => {
  it('computes reach fractions and places rungs only where enough clusters reach', () => {
    // 10 clusters: all reach 2×, half reach 3×, one reaches 5×
    const entries = [
      ...Array.from({ length: 5 }, () => ({ entryPrice: 1, postEntryMaxPrice: 3.5 })), // 3.5×
      ...Array.from({ length: 4 }, () => ({ entryPrice: 1, postEntryMaxPrice: 2.2 })), // 2.2×
      { entryPrice: 1, postEntryMaxPrice: 6 }, // 6×
    ];
    const r = analyzeProfitLadder(entries);
    expect(r.reached['2x']).toBeCloseTo(1.0, 6);
    expect(r.reached['3x']).toBeCloseTo(0.6, 6);
    expect(r.reached['5x']).toBeCloseTo(0.1, 6);
    expect(r.suggestedRungs.map((x) => x.at)).toEqual([2, 3, 5]);
  });
});

describe('freshness', () => {
  it('buckets returns by delay and estimates tau at 1/e decay', () => {
    const samples = [
      { delayMs: 2_000, forwardReturn: 1.0 },
      { delayMs: 4_000, forwardReturn: 1.0 },
      { delayMs: 40_000, forwardReturn: 0.2 }, // < 1/e of 1.0 → decayed by the ≤60s bucket
    ];
    const r = analyzeFreshness(samples);
    expect(r.n).toBe(3);
    expect(r.tauMsEstimate).not.toBeNull();
  });
});
