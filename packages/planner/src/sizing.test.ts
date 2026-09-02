import { describe, it, expect } from 'vitest';
import { ValidationError } from '@tip/domain';
import { deriveLeverage, maxSafeLeverage, positionSize } from './sizing.js';

describe('positionSize (§35)', () => {
  it('classic: 100k balance, 1% risk, $10 stop → 100 units', () => {
    const s = positionSize({ balance: 100_000, riskPercent: 0.01, entry: 100, stopLoss: 90, direction: 'LONG' });
    expect(s.riskBudget).toBe(1000);
    expect(s.positionSize).toBeCloseTo(100, 10);
    expect(s.notional).toBeCloseTo(10_000, 10);
  });

  it('SHORT stop must be ABOVE entry (LONG: below)', () => {
    expect(() => positionSize({ balance: 100, riskPercent: 0.01, entry: 100, stopLoss: 110, direction: 'LONG' })).toThrow(ValidationError);
    expect(() => positionSize({ balance: 100, riskPercent: 0.01, entry: 100, stopLoss: 90, direction: 'SHORT' })).toThrow(ValidationError);
  });

  it('rejects degenerate inputs', () => {
    expect(() => positionSize({ balance: 0, riskPercent: 0.01, entry: 100, stopLoss: 90, direction: 'LONG' })).toThrow();
    expect(() => positionSize({ balance: 100, riskPercent: 0, entry: 100, stopLoss: 90, direction: 'LONG' })).toThrow();
    expect(() => positionSize({ balance: 100, riskPercent: 1.5, entry: 100, stopLoss: 90, direction: 'LONG' })).toThrow();
    expect(() => positionSize({ balance: 100, riskPercent: 0.01, entry: 0, stopLoss: 90, direction: 'LONG' })).toThrow();
  });

  it('wider stop → smaller position at fixed risk', () => {
    const tight = positionSize({ balance: 100_000, riskPercent: 0.01, entry: 100, stopLoss: 99, direction: 'LONG' });
    const wide = positionSize({ balance: 100_000, riskPercent: 0.01, entry: 100, stopLoss: 90, direction: 'LONG' });
    expect(wide.positionSize).toBeLessThan(tight.positionSize);
    // Risk budget stays put; direction stays put; ordering derives from stop distance alone.
    expect(wide.riskBudget).toBe(tight.riskBudget);
  });

  it('takes NO `confidence` parameter — §35 anti-pattern enforced structurally', () => {
    // The test that matters isn't runtime: the signature has no `confidence` field. If someone
    // "helpfully" adds one, this assertion breaks at compile time via the object literal check.
    const args = { balance: 100, riskPercent: 0.01, entry: 100, stopLoss: 99, direction: 'LONG' as const };
    // @ts-expect-error — confidence must never be accepted here
    positionSize({ ...args, confidence: 0.99 });
    expect(positionSize(args).positionSize).toBeGreaterThan(0);
  });
});

describe('maxSafeLeverage / deriveLeverage (§35 — leverage is DERIVED, not chosen)', () => {
  it('wider stop → lower max-safe leverage', () => {
    const tight = maxSafeLeverage({ entry: 100, stopLoss: 99, direction: 'LONG', maintenanceMarginRate: 0.005, exchangeMaxLeverage: 100, userMaxLeverage: 100 });
    const wide = maxSafeLeverage({ entry: 100, stopLoss: 90, direction: 'LONG', maintenanceMarginRate: 0.005, exchangeMaxLeverage: 100, userMaxLeverage: 100 });
    expect(wide).toBeLessThan(tight);
  });

  it('at a 1% stop with 0.5% maintenance, max safe ≈ 1/(0.01+0.005) ≈ 66.7x', () => {
    const L = maxSafeLeverage({ entry: 100, stopLoss: 99, direction: 'LONG', maintenanceMarginRate: 0.005, exchangeMaxLeverage: 200, userMaxLeverage: 200 });
    expect(L).toBeCloseTo(1 / 0.015, 6);
  });

  it('derives min(maxSafe, exchange, user); never raises leverage to make a trade fit', () => {
    const d = deriveLeverage({ entry: 100, stopLoss: 90, direction: 'LONG', maintenanceMarginRate: 0.005, exchangeMaxLeverage: 100, userMaxLeverage: 3 }, 10_000);
    expect(d.allowed).toBe(3); // user cap wins over the wider max-safe
    expect(d.requiredMargin).toBeCloseTo(10_000 / 3, 6);
  });
});
