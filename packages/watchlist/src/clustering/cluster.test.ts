import { describe, it, expect } from 'vitest';
import { cluster, type FunderTaggedWallet } from './cluster.js';

const T = (h: number) => new Date(Date.UTC(2026, 0, 1, h)); // Jan 1 2026 hour h
const row = (walletId: string, funder: string, hour: number): FunderTaggedWallet => ({
  walletId, funder, fundedAt: T(hour),
});

// A deterministic id factory so tests can assert on grouping without hashing UUIDs.
let n = 0;
const stableIds = (): string => `cid-${++n}`;

describe('cluster (funder + 48h sliding window)', () => {
  it('groups 3 wallets sharing a funder within the window into one cluster', () => {
    n = 0;
    const clusters = cluster(
      [row('A', 'F1', 0), row('B', 'F1', 12), row('C', 'F1', 30)],
      { windowHours: 48, makeId: stableIds },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.funder).toBe('F1');
    expect(clusters[0]!.members.map((m) => m.walletId)).toEqual(['A', 'B', 'C']);
  });

  it('splits into separate clusters when the gap exceeds the window', () => {
    // Same funder, gap of 60h between second and third → new session, but each session <2 members
    // → no clusters. Add a companion for the second session to prove the split.
    n = 0;
    const clusters = cluster(
      [row('A', 'F1', 0), row('B', 'F1', 12), row('C', 'F1', 100), row('D', 'F1', 110)],
      { windowHours: 48, makeId: stableIds },
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.members.map((m) => m.walletId)).toEqual(['A', 'B']);
    expect(clusters[1]!.members.map((m) => m.walletId)).toEqual(['C', 'D']);
  });

  it('drops singletons — a lone-wallet funder produces no cluster', () => {
    n = 0;
    const clusters = cluster([row('A', 'F1', 0)], { windowHours: 48, makeId: stableIds });
    expect(clusters).toEqual([]);
  });

  it('disjoint funders → separate clusters', () => {
    n = 0;
    const clusters = cluster(
      [row('A', 'F1', 0), row('B', 'F1', 1), row('C', 'F2', 0), row('D', 'F2', 2)],
      { windowHours: 48, makeId: stableIds },
    );
    expect(clusters).toHaveLength(2);
    const funders = clusters.map((c) => c.funder).sort();
    expect(funders).toEqual(['F1', 'F2']);
  });

  it('boundary: exactly at the window is still in the cluster; 1s past is not', () => {
    n = 0;
    const exact = cluster(
      [row('A', 'F1', 0), row('B', 'F1', 48)],
      { windowHours: 48, makeId: stableIds },
    );
    expect(exact).toHaveLength(1);
    expect(exact[0]!.members).toHaveLength(2);

    n = 0;
    const overBy1s = cluster(
      [
        { walletId: 'A', funder: 'F1', fundedAt: T(0) },
        { walletId: 'B', funder: 'F1', fundedAt: new Date(T(48).getTime() + 1000) },
      ],
      { windowHours: 48, makeId: stableIds },
    );
    expect(overBy1s).toEqual([]);
  });

  it('deduplicates a wallet appearing twice in the same session', () => {
    n = 0;
    const clusters = cluster(
      [row('A', 'F1', 0), row('A', 'F1', 6), row('B', 'F1', 12)],
      { windowHours: 48, makeId: stableIds },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members.map((m) => m.walletId).sort()).toEqual(['A', 'B']);
  });
});
