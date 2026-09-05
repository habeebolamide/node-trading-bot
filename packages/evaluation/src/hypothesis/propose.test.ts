import { describe, it, expect } from 'vitest';
import { CATEGORY_TO_ADJUSTMENT_V1, applyWeightDelta, applyChange, PARAM_BOUNDS, proposeFromPattern, type Pattern } from './propose.js';

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

describe('applyChange — paramDelta (STOP_TOO_TIGHT tuning)', () => {
  it('STOP_TOO_TIGHT maps to a +minStopAtrMult paramDelta', () => {
    expect(CATEGORY_TO_ADJUSTMENT_V1.STOP_TOO_TIGHT).toEqual({
      kind: 'FAILURE',
      change: { kind: 'paramDelta', param: 'minStopAtrMult', delta: 0.25 },
    });
  });

  it('NO_FOLLOW_THROUGH raises the regime weight (anti-chop)', () => {
    expect(CATEGORY_TO_ADJUSTMENT_V1.NO_FOLLOW_THROUGH).toEqual({
      kind: 'FAILURE',
      change: { kind: 'weightDelta', agentKey: 'perp.market_regime', delta: 0.02 },
    });
  });

  it('TARGET_TOO_FAR pulls the TP cap in (−takeProfitAtrMult)', () => {
    expect(CATEGORY_TO_ADJUSTMENT_V1.TARGET_TOO_FAR).toEqual({
      kind: 'FAILURE',
      change: { kind: 'paramDelta', param: 'takeProfitAtrMult', delta: -0.25 },
    });
  });

  it('WRONG_FROM_ENTRY widens the NEUTRAL dead-zone (conviction filter)', () => {
    expect(CATEGORY_TO_ADJUSTMENT_V1.WRONG_FROM_ENTRY).toEqual({
      kind: 'FAILURE',
      change: { kind: 'thresholdWiden', delta: 0.05 },
    });
  });

  it('thresholdWiden pushes weak thresholds toward NEUTRAL, clamped at long/short', () => {
    const patch = applyChange(
      { signalThresholds: { long: 0.45, short: -0.45, weakLong: 0.2, weakShort: -0.2 } },
      { kind: 'thresholdWiden', delta: 0.05 },
    );
    const t = patch.signalThresholds as Record<string, number>;
    expect(t.weakLong).toBeCloseTo(0.25, 10);   // raised
    expect(t.weakShort).toBeCloseTo(-0.25, 10);  // lowered
    // Clamp: a huge widen can't cross the long/short bounds.
    const clamped = applyChange(
      { signalThresholds: { long: 0.45, short: -0.45, weakLong: 0.2, weakShort: -0.2 } },
      { kind: 'thresholdWiden', delta: 5 },
    );
    const c = clamped.signalThresholds as Record<string, number>;
    expect(c.weakLong).toBe(0.45);
    expect(c.weakShort).toBe(-0.45);
  });

  it('takeProfitAtrMult starts at its default (3.0) and steps down, clamped at min', () => {
    const first = applyChange({}, { kind: 'paramDelta', param: 'takeProfitAtrMult', delta: -0.25 });
    expect(first).toEqual({ takeProfitAtrMult: 2.75 });
    const floored = applyChange({ takeProfitAtrMult: PARAM_BOUNDS.takeProfitAtrMult.min }, { kind: 'paramDelta', param: 'takeProfitAtrMult', delta: -0.25 });
    expect(floored.takeProfitAtrMult).toBe(PARAM_BOUNDS.takeProfitAtrMult.min);
  });

  it('bumps the scalar param from the config value', () => {
    const patch = applyChange({ minStopAtrMult: 1.0 }, { kind: 'paramDelta', param: 'minStopAtrMult', delta: 0.25 });
    expect(patch).toEqual({ minStopAtrMult: 1.25 });
  });

  it('uses the sensible default (1.0) when the config has no value yet', () => {
    const patch = applyChange({}, { kind: 'paramDelta', param: 'minStopAtrMult', delta: 0.25 });
    expect(patch).toEqual({ minStopAtrMult: 1.25 });
  });

  it('clamps to PARAM_BOUNDS.max — never runs away', () => {
    const patch = applyChange({ minStopAtrMult: PARAM_BOUNDS.minStopAtrMult.max }, { kind: 'paramDelta', param: 'minStopAtrMult', delta: 0.25 });
    expect(patch.minStopAtrMult).toBe(PARAM_BOUNDS.minStopAtrMult.max);
  });

  it('weightDelta through applyChange still renormalizes agentWeights', () => {
    const patch = applyChange({ agentWeights: { a: 0.5, b: 0.5 } }, { kind: 'weightDelta', agentKey: 'a', delta: 0.1 });
    const w = patch.agentWeights as Record<string, number>;
    expect(w.a! + w.b!).toBeCloseTo(1, 10);
    expect(w.a!).toBeGreaterThan(w.b!);
  });
});
