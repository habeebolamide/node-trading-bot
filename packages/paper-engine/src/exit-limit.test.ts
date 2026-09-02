import { describe, it, expect } from 'vitest';
import { evalPendingTick } from './exit.js';

const T0 = new Date('2026-06-01T00:00:00Z');
const expiresAt = new Date(T0.getTime() + 6 * 3600_000);

describe('evalPendingTick — LIMIT crossings + expiry (m6-limit-orders-perp)', () => {
  it('LONG limit fills when price ≤ limit', () => {
    const r = evalPendingTick({ direction: 'LONG', limitPrice: 99, price: 98.5, now: T0, expiresAt });
    expect(r.kind).toBe('ACTIVATE_LIMIT');
    if (r.kind === 'ACTIVATE_LIMIT') expect(r.fillPrice).toBe(99);
  });

  it('LONG limit stays pending when price > limit', () => {
    const r = evalPendingTick({ direction: 'LONG', limitPrice: 99, price: 99.5, now: T0, expiresAt });
    expect(r.kind).toBe('NONE');
  });

  it('SHORT limit fills when price ≥ limit', () => {
    const r = evalPendingTick({ direction: 'SHORT', limitPrice: 101, price: 101.5, now: T0, expiresAt });
    expect(r.kind).toBe('ACTIVATE_LIMIT');
  });

  it('EXPIRE_LIMIT when now ≥ expiresAt AND no crossing', () => {
    const r = evalPendingTick({ direction: 'LONG', limitPrice: 90, price: 100, now: new Date(expiresAt.getTime() + 1000), expiresAt });
    expect(r.kind).toBe('EXPIRE_LIMIT');
  });

  it('FILL takes precedence over EXPIRY when both would fire on the same tick', () => {
    const r = evalPendingTick({ direction: 'LONG', limitPrice: 100, price: 99, now: new Date(expiresAt.getTime() + 1000), expiresAt });
    expect(r.kind).toBe('ACTIVATE_LIMIT');
  });
});
