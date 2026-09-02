import { describe, it, expect } from 'vitest';
import { dropOrder, globalSetupId, ladder } from './backoff.js';
import { MEMECOIN_DIMENSIONS, PERP_DIMENSIONS, type FeatureTuple } from './fingerprint.js';

const meme: FeatureTuple = {
  smart_money: 0.8, convergence: 0.5, momentum: -0.1, token_quality: 0.9, market_regime: 0.4,
};
const perp: FeatureTuple = {
  momentum: 0.6, open_interest: 0.4, market_regime: 0.2, liquidation: -0.3,
  funding: -0.8, positioning: 0.1, volume: 0.5, volatility: 0.7,
};

describe('dropOrder — ascending composite weight, alphabetical tiebreak', () => {
  it('memecoin drops least-weighted first, keeps smart money (25%) longest', () => {
    expect(dropOrder('memecoin')).toEqual([
      'market_regime',  // 5%
      'token_quality',  // 10%
      'momentum',       // 15%
      'convergence',    // 20%
      'smart_money',    // 25%
    ]);
  });

  it('perp drops volatility first — the dimension the plan\'s weight table does not rank', () => {
    const order = dropOrder('perp');
    expect(order[0]).toBe('volatility');
    // After volatility, the ladder degrades through exactly the plan-weighted 7.
    expect(order.slice(1)).toEqual([
      'volume',         // 5%
      'funding',        // 10%
      'positioning',    // 10%  (alphabetical tiebreak with funding)
      'liquidation',    // 15%
      'market_regime',  // 15%  (alphabetical tiebreak with liquidation)
      'momentum',       // 20%
      'open_interest',  // 20%  (alphabetical tiebreak — survives longest)
    ]);
  });

  it('is a permutation of the domain\'s dimensions — nothing added or lost', () => {
    expect([...dropOrder('memecoin')].sort()).toEqual([...MEMECOIN_DIMENSIONS].sort());
    expect([...dropOrder('perp')].sort()).toEqual([...PERP_DIMENSIONS].sort());
  });
});

describe('ladder', () => {
  it('memecoin has 6 rungs (5 dims + global), perp 9 (8 + global)', () => {
    expect(ladder('memecoin', meme)).toHaveLength(6);
    expect(ladder('perp', perp)).toHaveLength(9);
  });

  it('rung 0 is the exact fingerprint and retains everything', () => {
    const [first] = ladder('memecoin', meme);
    expect(first!.depth).toBe(0);
    expect(first!.retained).toEqual(MEMECOIN_DIMENSIONS);
    expect(first!.label).toBe('exact fingerprint');
  });

  it('each rung retains exactly one fewer dimension than the last', () => {
    const rungs = ladder('perp', perp);
    for (let i = 0; i < PERP_DIMENSIONS.length; i++) {
      expect(rungs[i]!.retained).toHaveLength(PERP_DIMENSIONS.length - i);
      expect(rungs[i]!.depth).toBe(i);
    }
  });

  it('the last rung is the global base rate and retains nothing', () => {
    const rungs = ladder('memecoin', meme);
    const last = rungs[rungs.length - 1]!;
    expect(last.retained).toEqual([]);
    expect(last.setupId).toBe(globalSetupId('memecoin'));
    expect(last.label).toBe('global base rate');
  });

  it('every rung has a distinct setupId — no arity collisions down the ladder', () => {
    for (const [domain, features] of [['memecoin', meme], ['perp', perp]] as const) {
      const ids = ladder(domain, features).map((r) => r.setupId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('domains have distinct global rows', () => {
    expect(globalSetupId('perp')).not.toBe(globalSetupId('memecoin'));
  });

  it('rung labels name what was dropped, in drop order', () => {
    const rungs = ladder('memecoin', meme);
    expect(rungs[1]!.label).toBe('dropped market_regime');
    expect(rungs[2]!.label).toBe('dropped market_regime, token_quality');
  });

  it('the ladder is stable for a given feature snapshot', () => {
    expect(ladder('perp', perp).map((r) => r.setupId)).toEqual(ladder('perp', perp).map((r) => r.setupId));
  });

  it('coarser rungs are shared across snapshots that differ only in a dropped dimension', () => {
    // This is the mechanism that makes backoff work: two setups differing only in market_regime
    // must land on the SAME rung-1 cell so their occurrences pool.
    const other: FeatureTuple = { ...meme, market_regime: -0.9 };
    const a = ladder('memecoin', meme);
    const b = ladder('memecoin', other);
    expect(b[0]!.setupId).not.toBe(a[0]!.setupId); // exact cells differ
    expect(b[1]!.setupId).toBe(a[1]!.setupId);     // rung 1 pools them
  });
});
