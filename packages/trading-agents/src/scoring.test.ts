import { describe, it, expect } from 'vitest';
import { composeSignal, directionFromComposite } from './scoring.js';
import type { AgentOutput } from './agent-interface.js';
import type { ScoringConfig } from './config.js';

const perpThresholds: ScoringConfig['signalThresholds'] = {
  strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7,
};
const memecoinThresholds: ScoringConfig['signalThresholds'] = { strongLong: 0.7, long: 0.45, weakLong: 0.2 };

const out = (agent: string, score: number, direction: AgentOutput['direction'] = 'LONG', over: Partial<AgentOutput> = {}): AgentOutput => ({
  agent, agentVersion: 1, direction, score, confidence: 0.8, features: {}, ...over,
});

describe('directionFromComposite', () => {
  it('maps perp buckets by threshold', () => {
    expect(directionFromComposite(0.9, perpThresholds, 'perp')).toBe('STRONG_LONG');
    expect(directionFromComposite(0.5, perpThresholds, 'perp')).toBe('LONG');
    expect(directionFromComposite(0.25, perpThresholds, 'perp')).toBe('WEAK_LONG');
    expect(directionFromComposite(0.0, perpThresholds, 'perp')).toBe('NEUTRAL');
    expect(directionFromComposite(-0.25, perpThresholds, 'perp')).toBe('WEAK_SHORT');
    expect(directionFromComposite(-0.5, perpThresholds, 'perp')).toBe('SHORT');
    expect(directionFromComposite(-0.9, perpThresholds, 'perp')).toBe('STRONG_SHORT');
  });
  it('memecoin is long-only: negative composite → NEUTRAL', () => {
    expect(directionFromComposite(0.5, memecoinThresholds, 'memecoin')).toBe('LONG');
    expect(directionFromComposite(-0.9, memecoinThresholds, 'memecoin')).toBe('NEUTRAL');
    expect(directionFromComposite(0.1, memecoinThresholds, 'memecoin')).toBe('NEUTRAL');
  });
});

describe('composeSignal', () => {
  it('returns null when no eligible agents contribute', () => {
    const r = composeSignal([], { 'x': 1 }, perpThresholds, 'perp');
    expect(r).toBeNull();
    const r2 = composeSignal([out('x', 0.5)], {}, perpThresholds, 'perp');
    expect(r2).toBeNull();
  });

  it('renormalizes weights so a partial roster produces comparable composites (§7 rule 1)', () => {
    // All positive scores → composite should be a proper weighted mean, in-range.
    const r = composeSignal(
      [out('a', 0.6), out('b', 0.9)],
      { a: 0.5, b: 0.5 },
      perpThresholds,
      'perp',
    );
    expect(r!.compositeScore).toBeCloseTo(0.75, 6);
    // Non-normalized weights should produce the same result after renormalization.
    const r2 = composeSignal(
      [out('a', 0.6), out('b', 0.9)],
      { a: 5, b: 5 },
      perpThresholds,
      'perp',
    );
    expect(r2!.compositeScore).toBeCloseTo(0.75, 6);
  });

  it('excludes agents whose key isn\'t in weights (§7 absent=disabled)', () => {
    const r = composeSignal(
      [out('a', 1.0), out('b', -1.0)],
      { a: 1 }, // b disabled
      perpThresholds,
      'perp',
    );
    expect(r!.compositeScore).toBe(1);
    expect(r!.contributingCount).toBe(1);
  });

  it('skips CONDITIONAL-skipped outputs', () => {
    const r = composeSignal(
      [out('a', 0.9, 'LONG', { skipped: true }), out('b', 0.3)],
      { a: 0.5, b: 0.5 },
      perpThresholds,
      'perp',
    );
    // a was skipped → only b contributes → composite = 0.3
    expect(r!.compositeScore).toBeCloseTo(0.3, 6);
    expect(r!.contributingCount).toBe(1);
  });

  it('agentAgreement: 100% when all contributing scores share sign', () => {
    const r = composeSignal(
      [out('a', 0.6), out('b', 0.4)],
      { a: 0.5, b: 0.5 },
      perpThresholds,
      'perp',
    );
    expect(r!.agentAgreement).toBe(1);
  });

  it('agentAgreement drops when signs conflict', () => {
    const r = composeSignal(
      [out('a', 0.6), out('b', -0.4)],
      { a: 0.5, b: 0.5 },
      perpThresholds,
      'perp',
    );
    expect(r!.agentAgreement).toBeCloseTo(0.5, 6);
  });

  it('clamps composite to [-1, +1] after rounding', () => {
    const r = composeSignal(
      [out('a', 1.5), out('b', 1.5)],
      { a: 1, b: 1 },
      perpThresholds,
      'perp',
    );
    expect(r!.compositeScore).toBe(1);
  });
});
