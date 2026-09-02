import { describe, it, expect } from 'vitest';
import { applyPostTakeAction, crossedLadderRungs, evalTick, walletExitAccumulator } from './exit.js';

const base = {
  entryPrice: 100, currentStop: 90, takeProfit: null, direction: 'LONG' as const,
  firedRungs: [] as number[], ladder: null,
};
const times = { now: new Date('2026-06-01T00:00:00Z'), horizonEndsAt: new Date('2026-06-01T04:00:00Z') };

describe('exit precedence (Part II §10)', () => {
  it('STOP LOSS above WALLET EXIT — a rug can outrun webhook latency', () => {
    const r = evalTick({ ...base, ...times, price: 89, walletExitReached: true });
    expect(r.kind).toBe('STOP_LOSS');
  });

  it('WALLET EXIT above LADDER RUNG — thesis death closes everything', () => {
    const ladder = [{ at: 2, sellFraction: 0.5 }];
    const r = evalTick({ ...base, ...times, ladder, price: 250, walletExitReached: true });
    expect(r.kind).toBe('WALLET_EXIT');
  });

  it('LADDER RUNG above TAKE PROFIT — but they are mutually exclusive by config', () => {
    const ladder = [{ at: 2, sellFraction: 0.5 }];
    const r = evalTick({ ...base, ...times, ladder, price: 210, walletExitReached: false });
    expect(r.kind).toBe('LADDER_RUNG');
  });

  it('TAKE PROFIT only when ladder is null', () => {
    const r = evalTick({ ...base, ...times, takeProfit: 105, price: 106, walletExitReached: false });
    expect(r.kind).toBe('TAKE_PROFIT');
  });

  it('HORIZON EXPIRY when nothing else fires', () => {
    const r = evalTick({ ...base, ...times, now: new Date('2026-06-01T05:00:00Z'), price: 100, walletExitReached: false });
    expect(r.kind).toBe('HORIZON_EXPIRY');
  });

  it('NONE otherwise', () => {
    const r = evalTick({ ...base, ...times, price: 100, walletExitReached: false });
    expect(r.kind).toBe('NONE');
  });
});

describe('ladder rung firing (Part II §10)', () => {
  const ladder = [
    { at: 2.0, sellFraction: 0.5, postTakeAction: 'move_stop_to_breakeven' as const },
    { at: 3.0, sellFraction: 0.25 },
    { at: 5.0, sellFraction: 0.15 },
  ];

  it('fires the next unfired rung in order', () => {
    const r0 = crossedLadderRungs(100, 210, ladder, []);
    expect(r0).toEqual([0]);
    const r1 = crossedLadderRungs(100, 310, ladder, [0]);
    expect(r1).toEqual([1]);
  });

  it('each rung fires AT MOST once (firedRungs guards)', () => {
    const r = crossedLadderRungs(100, 250, ladder, [0]);
    expect(r).toEqual([]);
    // rung 0 crossed but already fired; next rung not crossed yet → nothing to fire
  });

  it('gap-up hits ONLY the rungs actually crossed, in order', () => {
    const r = crossedLadderRungs(100, 350, ladder, []);
    expect(r).toEqual([0, 1]);           // NOT [0,1,2]; 5x not crossed
  });

  it('cumulative sellFraction across all rungs ≤ 1.0 (config invariant is enforced by validateScoringConfig at write)', () => {
    const total = ladder.reduce((a, b) => a + b.sellFraction, 0);
    expect(total).toBeCloseTo(0.9, 10); // leaves a 10% moon-bag by design (Part II §10)
    expect(total).toBeLessThanOrEqual(1);
  });
});

describe('walletExitAccumulator (Part II §10)', () => {
  it('is Σ (1 − heldFraction) × entryWeight — partial sells contribute proportionally', () => {
    const rows = [
      { currentHeldFraction: 1, entryWeight: 0.5 },
      { currentHeldFraction: 0.4, entryWeight: 0.3 },
      { currentHeldFraction: 0, entryWeight: 0.2 },
    ];
    // (0)(0.5) + (0.6)(0.3) + (1)(0.2) = 0.38
    expect(walletExitAccumulator(rows)).toBeCloseTo(0.38, 10);
  });

  it('zero when nobody has sold', () => {
    expect(walletExitAccumulator([{ currentHeldFraction: 1, entryWeight: 0.5 }])).toBe(0);
  });

  it('cluster dedup: one funder through five addresses shows up as ONE weighted contribution', () => {
    // The dedup is done UPSTREAM by §5 — every row's entryWeight is already cluster-weighted, so
    // the accumulator does not itself dedup. Asserting the invariant: five rows sharing a
    // clusterId should contribute their SUMMED weight, not 5× a single wallet's raw weight.
    const clusterWeight = 0.3;
    const perAddressEntryWeight = clusterWeight / 5;
    const rows = Array.from({ length: 5 }, () => ({ currentHeldFraction: 0, entryWeight: perAddressEntryWeight }));
    expect(walletExitAccumulator(rows)).toBeCloseTo(clusterWeight, 10);
  });
});

describe('applyPostTakeAction (Part II §10)', () => {
  it('null keeps the prior stop', () => {
    expect(applyPostTakeAction({ entryPrice: 100, currentStop: 90, currentPrice: 200, action: null })).toBe(90);
  });
  it('move_stop_to_breakeven raises to entry — never lowers', () => {
    expect(applyPostTakeAction({ entryPrice: 100, currentStop: 90, currentPrice: 200, action: 'move_stop_to_breakeven' })).toBe(100);
    // If a later post-take action would try to lower it, we keep the max.
    expect(applyPostTakeAction({ entryPrice: 100, currentStop: 105, currentPrice: 200, action: 'move_stop_to_breakeven' })).toBe(105);
  });
  it('trail_stop_pct follows price up, NEVER down (Part II §10)', () => {
    const upFrom90 = applyPostTakeAction({ entryPrice: 100, currentStop: 90, currentPrice: 300, action: { trail_stop_pct: 0.1 } });
    expect(upFrom90).toBeCloseTo(270, 10);
    // A subsequent lower price does not pull the trail down.
    const dontDrop = applyPostTakeAction({ entryPrice: 100, currentStop: 270, currentPrice: 200, action: { trail_stop_pct: 0.1 } });
    expect(dontDrop).toBe(270);
  });
});
