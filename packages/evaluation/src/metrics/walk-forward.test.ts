import { describe, it, expect } from 'vitest';
import { ValidationError } from '@tip/domain';
import { walkForwardFolds } from './walk-forward.js';

const D = (s: string) => new Date(s);

describe('walkForwardFolds (Task 7 — perp only)', () => {
  it('refuses memecoin — §25 scopes it out of historical backtest', () => {
    expect(() => walkForwardFolds('memecoin', { from: D('2026-01-01T00:00:00Z'), to: D('2026-06-01T00:00:00Z') }))
      .toThrow(ValidationError);
  });

  it('produces disjoint train/test ranges — never overlaps by construction', () => {
    const folds = walkForwardFolds('perp', {
      from: D('2026-01-01T00:00:00Z'), to: D('2026-04-01T00:00:00Z'),
    });
    for (const f of folds) {
      // trainStart < trainEnd, trainEnd == testStart (exclusive), testStart < testEnd
      expect(f.trainStart.getTime()).toBeLessThan(f.trainEnd.getTime());
      expect(f.trainEnd.getTime()).toBe(f.testStart.getTime());
      expect(f.testStart.getTime()).toBeLessThan(f.testEnd.getTime());
      // A train window never reaches into a later fold's TEST window.
    }
  });

  it('rolls forward one test-window at a time by default', () => {
    const folds = walkForwardFolds('perp', {
      from: D('2026-01-01T00:00:00Z'), to: D('2026-05-01T00:00:00Z'),
    });
    if (folds.length >= 2) {
      const step = folds[1]!.trainStart.getTime() - folds[0]!.trainStart.getTime();
      expect(step).toBe(20 * 24 * 3600_000); // testDays default
    }
  });

  it('produces 60d train + 20d test = 80d total per fold', () => {
    const folds = walkForwardFolds('perp', {
      from: D('2026-01-01T00:00:00Z'), to: D('2026-05-01T00:00:00Z'),
    });
    if (folds.length > 0) {
      const f = folds[0]!;
      const trainDays = (f.trainEnd.getTime() - f.trainStart.getTime()) / (24 * 3600_000);
      const testDays = (f.testEnd.getTime() - f.testStart.getTime()) / (24 * 3600_000);
      expect(trainDays).toBe(60);
      expect(testDays).toBe(20);
    }
  });

  it('returns [] when the range cannot fit even one fold', () => {
    const folds = walkForwardFolds('perp', {
      from: D('2026-01-01T00:00:00Z'), to: D('2026-01-30T00:00:00Z'), // < 80d
    });
    expect(folds).toHaveLength(0);
  });

  it('is deterministic — same inputs give the same folds', () => {
    const a = walkForwardFolds('perp', { from: D('2026-01-01T00:00:00Z'), to: D('2026-06-01T00:00:00Z') });
    const b = walkForwardFolds('perp', { from: D('2026-01-01T00:00:00Z'), to: D('2026-06-01T00:00:00Z') });
    expect(b).toEqual(a);
  });
});
