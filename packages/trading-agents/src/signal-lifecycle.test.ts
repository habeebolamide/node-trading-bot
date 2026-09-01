import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition } from './signal-lifecycle.js';

describe('signal-lifecycle (§36)', () => {
  it('ACTIVE can go to EXPIRED / INVALIDATED / CONSUMED', () => {
    expect(canTransition('ACTIVE', 'EXPIRED')).toBe(true);
    expect(canTransition('ACTIVE', 'INVALIDATED')).toBe(true);
    expect(canTransition('ACTIVE', 'CONSUMED')).toBe(true);
  });
  it('terminal states cannot transition', () => {
    for (const from of ['EXPIRED', 'INVALIDATED', 'CONSUMED'] as const) {
      for (const to of ['ACTIVE', 'EXPIRED', 'INVALIDATED', 'CONSUMED'] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
  it('assertTransition throws on invalid transitions', () => {
    expect(() => assertTransition('CONSUMED', 'ACTIVE')).toThrow(/invalid signal state transition/);
  });
});
