import { describe, it, expect } from 'vitest';
import { resolveOutcome } from './resolve.js';

const T1 = new Date('2026-06-01T00:00:00Z');
const HORIZON_END = new Date(T1.getTime() + 60 * 60_000); // 1h

/** Synthesize 1m bars from a stream of (o,h,l,c). */
function bars(rows: readonly [number, number, number, number][]) {
  return rows.map(([o, h, l, c], i) => ({
    openTime: new Date(T1.getTime() + i * 60_000),
    closeTime: new Date(T1.getTime() + (i + 1) * 60_000 - 1),
    open: o, high: h, low: l, close: c,
  }));
}

describe('resolveOutcome — TICK mode', () => {
  const base = {
    entry: 100, stopLoss: 98, takeProfit: 104, direction: 'LONG' as const,
    t1: T1, horizonEnd: HORIZON_END, mode: 'TICK' as const,
  };

  it('resolves WIN when TP touched before SL', () => {
    const ticks = [
      { at: new Date(T1.getTime() + 60_000), price: 101 },
      { at: new Date(T1.getTime() + 120_000), price: 105 }, // TP
      { at: new Date(T1.getTime() + 180_000), price: 97 },  // SL later — ignored
    ];
    const r = resolveOutcome({ ...base, ticks });
    expect(r.won).toBe(true);
    expect(r.hitTarget).toBe(true);
    expect(r.hitInvalidation).toBe(false);
    expect(r.returnPct).toBeCloseTo((104 - 100) / 100, 6);
    expect(r.holdingPeriodSec).toBe(120);
  });

  it('resolves LOSS when SL touched before TP', () => {
    const ticks = [
      { at: new Date(T1.getTime() + 60_000), price: 97 }, // SL
      { at: new Date(T1.getTime() + 120_000), price: 106 }, // ignored
    ];
    const r = resolveOutcome({ ...base, ticks });
    expect(r.won).toBe(false);
    expect(r.hitInvalidation).toBe(true);
    expect(r.hitTarget).toBe(false);
    expect(r.returnPct).toBeCloseTo(-0.02, 6);
  });

  it('neither touched → resolves at last observed price at horizon end', () => {
    const ticks = [{ at: new Date(T1.getTime() + 60_000), price: 101 }];
    const r = resolveOutcome({ ...base, ticks });
    expect(r.won).toBe(false);
    expect(r.hitTarget).toBe(false);
    expect(r.hitInvalidation).toBe(false);
    expect(r.returnPct).toBeCloseTo(0.01, 6);
  });

  it('signed correctly for SHORT — MFE is favourable, MAE adverse', () => {
    const ticks = [
      { at: new Date(T1.getTime() + 60_000), price: 95 }, // favourable for SHORT
      { at: new Date(T1.getTime() + 120_000), price: 103 }, // adverse
    ];
    const r = resolveOutcome({ entry: 100, stopLoss: 105, takeProfit: 90, direction: 'SHORT', t1: T1, horizonEnd: HORIZON_END, mode: 'TICK', ticks });
    expect(r.mfe).toBeCloseTo(0.05, 6);
    expect(r.mae).toBeCloseTo(-0.03, 6);
  });
});

describe('resolveOutcome — CANDLE_1M_CONSERVATIVE mode', () => {
  const base = {
    entry: 100, stopLoss: 98, takeProfit: 104, direction: 'LONG' as const,
    t1: T1, horizonEnd: HORIZON_END, mode: 'CANDLE_1M_CONSERVATIVE' as const,
  };

  it('AMBIGUOUS BAR (spans both TP and SL) → SL first (§25 pessimistic tie-break)', () => {
    // The methodological point of the whole change. A 1m bar cannot say which came first, so
    // we bias downward — the direction that costs a missed trade, not a taken loss (§25).
    const r = resolveOutcome({ ...base, bars: bars([[100, 106, 97, 101]]) });
    expect(r.won).toBe(false);
    expect(r.hitInvalidation).toBe(true);
    expect(r.hitTarget).toBe(false);
    expect(r.returnPct).toBeCloseTo(-0.02, 6);
  });

  it('unambiguous TP crossing (no SL in-bar) resolves as WIN', () => {
    const r = resolveOutcome({ ...base, bars: bars([[100, 105, 99, 103]]) });
    expect(r.won).toBe(true);
    expect(r.hitTarget).toBe(true);
  });

  it('unambiguous SL crossing resolves as LOSS', () => {
    const r = resolveOutcome({ ...base, bars: bars([[100, 101, 97, 100]]) });
    expect(r.won).toBe(false);
    expect(r.hitInvalidation).toBe(true);
  });

  it('nothing touched inside horizon → resolves at last-bar close, alpha vs benchmark', () => {
    const r = resolveOutcome({ ...base, bars: bars([[100, 101, 99, 100.5], [100.5, 101, 100, 100.5]]),
      benchmarkReturnPct: 0.001 });
    expect(r.hitTarget).toBe(false);
    expect(r.hitInvalidation).toBe(false);
    expect(r.returnPct).toBeCloseTo(0.005, 6);
    expect(r.alpha).toBeCloseTo(0.004, 6);
  });

  it('MFE/MAE track bar extremes, direction-signed', () => {
    const r = resolveOutcome({ ...base, bars: bars([[100, 103, 99, 100], [100, 100, 97.5, 98.5]]) });
    // Neither TP (104) nor SL (98) crossed on bar 1. bar 2: low 97.5 < SL 98 → LOSS.
    // Before the SL fires, mfe should have reached +0.03 (high 103) and mae 0 (low 99 not below entry).
    expect(r.hitInvalidation).toBe(true);
    expect(r.mfe).toBeCloseTo(0.03, 6);
    expect(r.mae).toBeCloseTo(-0.025, 6);
  });

  it('CANDLE mode without TP (memecoin ladder) — cannot win via TP, only SL/nothing', () => {
    const r = resolveOutcome({ ...base, takeProfit: null, bars: bars([[100, 105, 99, 100]]) });
    expect(r.hitTarget).toBe(false);
    expect(r.won).toBe(false);
  });

  it('bar range strictly BEFORE t1 is ignored (no look-ahead into the past pre-fill)', () => {
    const preT1 = { openTime: new Date(T1.getTime() - 120_000), closeTime: new Date(T1.getTime() - 60_000), open: 100, high: 200, low: 50, close: 100 };
    const r = resolveOutcome({ ...base, bars: [preT1, ...bars([[100, 101, 99, 100]])] });
    expect(r.hitTarget).toBe(false);
    expect(r.hitInvalidation).toBe(false);
    // MFE/MAE unaffected by the pre-T1 bar's extreme range.
    expect(r.mfe).toBeCloseTo(0.01, 6);
  });
});
