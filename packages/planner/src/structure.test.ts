import { describe, it, expect } from 'vitest';
import { collapsePivots, nearestLevels, swingPivots, type StructureBar } from './structure.js';

const bar = (t: number, h: number, l: number): StructureBar =>
  ({ high: h, low: l, closeTime: new Date(t) });

describe('swingPivots', () => {
  it('returns nothing when there are too few bars', () => {
    expect(swingPivots([bar(1, 1, 0), bar(2, 2, 1)], 2)).toEqual([]);
  });

  it('finds a confirmed swing high with k neighbours on both sides', () => {
    // The middle bar is the highest; k=2 needs two lower highs on each side.
    const bars = [1, 2, 3, 5, 3, 2, 1].map((h, i) => bar(i, h, h - 1));
    const p = swingPivots(bars, 2);
    expect(p).toHaveLength(1);
    expect(p[0]!.kind).toBe('HIGH');
    expect(p[0]!.price).toBe(5);
  });

  it('never marks the trailing k bars as pivots — unconfirmed and would leak look-ahead', () => {
    const bars = [1, 2, 3, 4, 5].map((h, i) => bar(i, h, h - 1)); // monotonic; the last bar is a "high" but unconfirmed
    expect(swingPivots(bars, 2)).toEqual([]);
  });

  it('uses strict inequality — a flat plateau spawns no pivots', () => {
    const bars = [1, 5, 5, 5, 1].map((h, i) => bar(i, h, h - 1));
    expect(swingPivots(bars, 2)).toEqual([]);
  });

  it('is deterministic — same input twice, same output', () => {
    const bars = [1, 2, 3, 5, 3, 4, 2, 1].map((h, i) => bar(i, h, h - 1));
    expect(swingPivots(bars, 2)).toEqual(swingPivots(bars, 2));
  });
});

describe('collapsePivots', () => {
  const near1 = { price: 100.05, at: new Date(1), kind: 'HIGH' as const, touches: 1 };
  const near2 = { price: 100.10, at: new Date(2), kind: 'HIGH' as const, touches: 1 };
  const far = { price: 102.0, at: new Date(3), kind: 'HIGH' as const, touches: 1 };

  it('merges pivots within atrFactor×ATR into one — more-touched wins', () => {
    const collapsed = collapsePivots([near1, near2, far], /* atr */ 1, /* factor */ 0.25);
    // near1 + near2 are within 0.25; they collapse. far is > 0.25 away.
    expect(collapsed).toHaveLength(2);
    const merged = collapsed.find((p) => Math.abs(p.price - 100.05) < 0.2)!;
    expect(merged.touches).toBe(2);
  });

  it('returns pivots unchanged when ATR is zero or none are near', () => {
    expect(collapsePivots([near1, far], 0)).toHaveLength(2);
  });
});

describe('nearestLevels', () => {
  const pivots = [
    { price: 90, at: new Date(1), kind: 'LOW' as const, touches: 1 },
    { price: 95, at: new Date(2), kind: 'LOW' as const, touches: 1 },
    { price: 110, at: new Date(3), kind: 'HIGH' as const, touches: 1 },
    { price: 120, at: new Date(4), kind: 'HIGH' as const, touches: 1 },
  ];

  it('picks the nearest LOW below and nearest HIGH above the reference', () => {
    const { supportBelow, resistanceAbove } = nearestLevels(100, pivots);
    expect(supportBelow!.price).toBe(95);
    expect(resistanceAbove!.price).toBe(110);
  });

  it('returns null when nothing lies on that side', () => {
    expect(nearestLevels(80, pivots).supportBelow).toBeNull();
    expect(nearestLevels(200, pivots).resistanceAbove).toBeNull();
  });

  it('strictly below / strictly above — a pivot exactly at the price is not "nearest"', () => {
    const { supportBelow, resistanceAbove } = nearestLevels(95, pivots);
    expect(supportBelow!.price).toBe(90);
    expect(resistanceAbove!.price).toBe(110);
  });
});
