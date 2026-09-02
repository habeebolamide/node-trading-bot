import { describe, it, expect } from 'vitest';
import { CATEGORY_TO_ADJUSTMENT_V1, applyWeightDelta, proposeFromPattern, type Pattern } from './propose.js';

const pattern = (over: Partial<Pattern> = {}): Pattern => ({
  setupId: 'abc', domain: 'perp', category: 'POSITIONING_MISREAD', categoryKind: 'FAILURE',
  evidenceCount: 22, ...over,
});

describe('proposeFromPattern (§24 hard rule — LLM never proposes the number, code does)', () => {
  it('known FAILURE category → weightDelta proposal from the table', () => {
    const p = proposeFromPattern(pattern());
    expect(p).not.toBeNull();
    expect(p!.proposedChange).toEqual({ kind: 'weightDelta', agentKey: 'perp.positioning', delta: 0.03 });
  });

  it('known SUCCESS category → weightDelta proposal', () => {
    const p = proposeFromPattern(pattern({ category: 'MOMENTUM_CONFIRMED_EARLY', categoryKind: 'SUCCESS' }));
    expect(p).not.toBeNull();
    expect(p!.proposedChange).toEqual({ kind: 'weightDelta', agentKey: 'perp.momentum', delta: 0.02 });
  });

  it('unknown category → null (no guessing — a new category is a code change)', () => {
    expect(proposeFromPattern(pattern({ category: 'INVENTED' }))).toBeNull();
  });

  it('category kind must match table entry — FAILURE category with SUCCESS pattern → null', () => {
    expect(proposeFromPattern(pattern({ category: 'MOMENTUM_CONFIRMED_EARLY', categoryKind: 'FAILURE' }))).toBeNull();
    expect(proposeFromPattern(pattern({ category: 'POSITIONING_MISREAD', categoryKind: 'SUCCESS' }))).toBeNull();
  });

  it('deltas are conservative (|Δ| ≤ 0.05) — a promoted change is hard to unwind', () => {
    for (const entry of Object.values(CATEGORY_TO_ADJUSTMENT_V1)) {
      if (entry.change.kind === 'weightDelta') expect(Math.abs(entry.change.delta)).toBeLessThanOrEqual(0.05);
    }
  });
});

describe('applyWeightDelta', () => {
  it('sums back to 1 after applying a delta (renormalized)', () => {
    const before = { a: 0.5, b: 0.5 };
    const after = applyWeightDelta(before, { kind: 'weightDelta', agentKey: 'a', delta: 0.1 });
    const total = Object.values(after).reduce((x, y) => x + y, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(after.a!).toBeGreaterThan(after.b!);
  });

  it('clamps a weight at 0 rather than going negative', () => {
    const after = applyWeightDelta({ a: 0.05, b: 0.95 }, { kind: 'weightDelta', agentKey: 'a', delta: -0.5 });
    expect(after.a).toBe(0);
    expect(after.b).toBeCloseTo(1, 10);
  });

  it('a missing agent starts at 0 and adds the positive delta', () => {
    const after = applyWeightDelta({ a: 1 }, { kind: 'weightDelta', agentKey: 'b', delta: 0.2 });
    // Both nonzero → renormalized to sum 1.
    expect(after.a! + after.b!).toBeCloseTo(1, 10);
    expect(after.b!).toBeGreaterThan(0);
  });
});
