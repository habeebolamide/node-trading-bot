import { describe, it, expect } from 'vitest';
import { aggregate, timeCompressionFor, type Buy } from './aggregator.js';

const T = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
const buy = (wallet: string, walletScore: number, sig: string, ms: number, amountSol = '1'): Buy => ({
  wallet, walletScore, amountSol, tokenAmount: '1000', blockTime: T(ms), signature: sig,
});

describe('timeCompressionFor', () => {
  it('1.0 at span 0; 0.5 at exactly the window; linear in between; clamped past', () => {
    expect(timeCompressionFor(0, 5000)).toBe(1);
    expect(timeCompressionFor(2500, 5000)).toBeCloseTo(0.75, 6);
    expect(timeCompressionFor(5000, 5000)).toBe(0.5);
    expect(timeCompressionFor(10_000, 5000)).toBe(0.5); // clamp
  });
});

describe('aggregate', () => {
  it('three wallets from three distinct clusters → independentClusterCount=3', () => {
    const clusters = new Map([['A', 'c1'], ['B', 'c2'], ['C', 'c3']]);
    const r = aggregate(
      [buy('A', 80, 'sA', 0), buy('B', 80, 'sB', 100), buy('C', 80, 'sC', 200)],
      clusters,
      { batchingWindowMs: 5000 },
    );
    expect(r.independentClusterCount).toBe(3);
    expect(r.perCluster.map((c) => c.clusterId).sort()).toEqual(['cluster:c1', 'cluster:c2', 'cluster:c3']);
  });

  it('five wallets sharing ONE funder collapse to independentClusterCount=1', () => {
    const clusters = new Map(['A', 'B', 'C', 'D', 'E'].map((w) => [w, 'cSHARED']));
    const r = aggregate(
      ['A', 'B', 'C', 'D', 'E'].map((w, i) => buy(w, 80, `s${w}`, i * 100)),
      clusters,
      { batchingWindowMs: 5000 },
    );
    expect(r.independentClusterCount).toBe(1);
    expect(r.perCluster[0]!.wallets.sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('wallets not in the cluster map become "solo" clusters (still contribute)', () => {
    const r = aggregate([buy('X', 80, 'sX', 0)], new Map(), { batchingWindowMs: 5000 });
    expect(r.independentClusterCount).toBe(1);
    expect(r.perCluster[0]!.clusterId).toBe('solo:X');
  });

  it('caps clusterQuality per Task 6', () => {
    const clusters = new Map([['A', 'c1'], ['B', 'c1']]);
    const r = aggregate([buy('A', 200, 'sA', 0), buy('B', 200, 'sB', 100)], clusters, {
      batchingWindowMs: 5000,
      clusterQualityCap: 100,
    });
    expect(r.perCluster[0]!.clusterQuality).toBe(100); // capped
  });

  it('applies time compression: tighter batch → higher score', () => {
    const clusters = new Map([['A', 'c1'], ['B', 'c2']]);
    const tight = aggregate(
      [buy('A', 80, 'sA', 0), buy('B', 80, 'sB', 100)],
      clusters,
      { batchingWindowMs: 5000 },
    );
    const loose = aggregate(
      [buy('A', 80, 'sA', 0), buy('B', 80, 'sB', 5000)],
      clusters,
      { batchingWindowMs: 5000 },
    );
    expect(tight.convergenceScore).toBeGreaterThan(loose.convergenceScore);
    expect(loose.timeCompression).toBeCloseTo(0.5, 6);
  });

  it('dedups a repeated (wallet, signature) pair', () => {
    const clusters = new Map([['A', 'c1']]);
    const r = aggregate(
      [buy('A', 80, 'sameSig', 0), buy('A', 80, 'sameSig', 100)],
      clusters,
      { batchingWindowMs: 5000 },
    );
    expect(r.perCluster[0]!.wallets).toEqual(['A']);
    // With only 1 unique buy, span=0 → timeCompression=1
    expect(r.timeCompression).toBe(1);
  });
});
