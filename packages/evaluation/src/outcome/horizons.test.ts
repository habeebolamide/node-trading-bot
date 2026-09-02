import { describe, it, expect } from 'vitest';
import { horizonSet, planningHorizonFor } from './horizons.js';

describe('horizonSet (Task 7 — style triad + 1h cross-style reference)', () => {
  it('day style: [1h, 4h, EOD] — 1h already included, so no dup', () => {
    expect(horizonSet('day')).toEqual(['1h', '4h', 'EOD']);
  });
  it('scalp style: [5m, 15m, 30m, 1h] — appends 1h reference', () => {
    expect(horizonSet('scalp')).toEqual(['5m', '15m', '30m', '1h']);
  });
  it('swing style: [1d, 3d, 1w, 1h] — 1h added for cross-style comparability', () => {
    expect(horizonSet('swing')).toEqual(['1d', '3d', '1w', '1h']);
  });
});

describe('planningHorizonFor (§8 middle of triad)', () => {
  it('picks the middle: day → 4h, scalp → 15m, swing → 3d', () => {
    expect(planningHorizonFor('day')).toBe('4h');
    expect(planningHorizonFor('scalp')).toBe('15m');
    expect(planningHorizonFor('swing')).toBe('3d');
  });
});
