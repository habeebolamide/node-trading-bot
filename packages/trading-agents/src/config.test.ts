import { describe, it, expect } from 'vitest';
import { validateScoringConfig } from './config.js';
import { ValidationError } from '@tip/domain';

const basePerp = {
  riskPercent: 0.01,
  minRR: 1.5,
  maxConcurrentPositions: 3,
  leverageMax: 10,
  agentWeights: { 'perp.momentum': 0.2 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

const baseMemecoin = {
  riskPercent: 0.02,
  minRR: 0, // memecoin: config check only, not per-trade veto
  maxConcurrentPositions: 1, // required
  agentWeights: { 'memecoin.smart_money': 0.25 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2 },
  stopPct: 0.3,
};

describe('validateScoringConfig — perp', () => {
  it('accepts a valid perp config and fills default confidenceWeights (Task 6)', () => {
    const cfg = validateScoringConfig(basePerp, 'perp');
    expect(cfg.confidenceWeights).toEqual({ signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 });
  });
  it('rejects memecoin-specific fields on a perp config', () => {
    expect(() => validateScoringConfig({ ...basePerp, stopPct: 0.3 }, 'perp')).toThrow(ValidationError);
  });
  it('rejects riskPercent > 1 and 0', () => {
    expect(() => validateScoringConfig({ ...basePerp, riskPercent: 1.5 }, 'perp')).toThrow(ValidationError);
    expect(() => validateScoringConfig({ ...basePerp, riskPercent: 0 }, 'perp')).toThrow(ValidationError);
  });
});

describe('validateScoringConfig — memecoin (§32)', () => {
  it('rejects maxConcurrentPositions != 1 (domain rule)', () => {
    expect(() => validateScoringConfig({ ...baseMemecoin, maxConcurrentPositions: 3 }, 'memecoin')).toThrow(ValidationError);
  });
  it('rejects leverageMax (memecoin is spot)', () => {
    expect(() => validateScoringConfig({ ...baseMemecoin, leverageMax: 10 }, 'memecoin')).toThrow(ValidationError);
  });
  it('accepts a valid profit ladder', () => {
    const cfg = validateScoringConfig(
      { ...baseMemecoin, profitLadder: [
        { at: 2.0, sellFraction: 0.5, postTakeAction: 'move_stop_to_breakeven' },
        { at: 3.0, sellFraction: 0.25 },
        { at: 5.0, sellFraction: 0.15 },
      ] },
      'memecoin',
    );
    expect(cfg.profitLadder).toHaveLength(3);
  });
  it('rejects a profit ladder with cumulative sellFraction > 1.0', () => {
    expect(() => validateScoringConfig(
      { ...baseMemecoin, profitLadder: [
        { at: 2.0, sellFraction: 0.6 },
        { at: 3.0, sellFraction: 0.5 },
      ] },
      'memecoin',
    )).toThrow(/cumulative sellFraction/);
  });
  it('rejects out-of-order profit-ladder rungs', () => {
    expect(() => validateScoringConfig(
      { ...baseMemecoin, profitLadder: [
        { at: 3.0, sellFraction: 0.5 },
        { at: 2.0, sellFraction: 0.25 },
      ] },
      'memecoin',
    )).toThrow(/ascending/);
  });
});
