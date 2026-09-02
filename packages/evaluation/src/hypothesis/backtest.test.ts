import { describe, it, expect } from 'vitest';
import type { HeadlineMetrics } from '../metrics/metrics.js';
import { isImprovement, pickBacktestFold, pickOOSFold } from './backtest.js';

const mkMetrics = (over: Partial<HeadlineMetrics> = {}): HeadlineMetrics => ({
  domain: 'perp', configVersion: 1, horizon: '4h',
  n: 30, wins: 20, accuracy: 20 / 30,
  wilsonLower: 0.5, wilsonUpper: 0.8,
  medianReturn: 0.02, meanReturn: 0.03, meanAlpha: 0.01, maxDrawdown: 0.05,
  ...over,
});

describe('isImprovement (§24 non-overlap Wilson gate)', () => {
  it('null on either side → not improved', () => {
    expect(isImprovement(null, mkMetrics()).improved).toBe(false);
    expect(isImprovement(mkMetrics(), null).improved).toBe(false);
  });
  it('same numbers → not improved', () => {
    expect(isImprovement(mkMetrics(), mkMetrics()).improved).toBe(false);
  });
  it('accuracy down → not improved even with better alpha', () => {
    const r = isImprovement(mkMetrics(), mkMetrics({ accuracy: 0.4, meanAlpha: 0.2 }));
    expect(r.improved).toBe(false);
  });
  it('accuracy up + alpha up + non-overlapping Wilson → IMPROVED', () => {
    const inc = mkMetrics({ accuracy: 0.5, wilsonLower: 0.3, wilsonUpper: 0.5, meanAlpha: 0.005 });
    const pro = mkMetrics({ accuracy: 0.9, wilsonLower: 0.7, wilsonUpper: 0.98, meanAlpha: 0.03 });
    expect(isImprovement(inc, pro).improved).toBe(true);
  });
  it('accuracy up + alpha up but OVERLAPPING Wilson → NOT improved (no measurable difference)', () => {
    const inc = mkMetrics({ accuracy: 0.6, wilsonLower: 0.5, wilsonUpper: 0.8 });
    const pro = mkMetrics({ accuracy: 0.7, wilsonLower: 0.6, wilsonUpper: 0.85, meanAlpha: 0.02 });
    const r = isImprovement(inc, pro);
    expect(r.improved).toBe(false);
    expect(r.reason).toContain('§24');
  });
});

describe('walk-forward fold picking', () => {
  it('pickBacktestFold picks the last fitting fold', () => {
    const fold = pickBacktestFold({
      db: {} as never, configVersion: 1, horizon: '4h',
      range: { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-06-01T00:00:00Z') },
    });
    expect(fold).not.toBeNull();
  });
  it('pickOOSFold returns a strictly-later disjoint window', () => {
    const bt = pickBacktestFold({
      db: {} as never, configVersion: 1, horizon: '4h',
      range: { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-06-01T00:00:00Z') },
    })!;
    const oos = pickOOSFold(bt)!;
    expect(oos.testStart.getTime()).toBeGreaterThanOrEqual(bt.testEnd.getTime());
    expect(oos.testEnd.getTime()).toBeGreaterThan(oos.testStart.getTime());
  });
});
