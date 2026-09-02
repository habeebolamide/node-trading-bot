import { describe, it, expect } from 'vitest';
import { validateScoringConfig, DEFAULT_AGENT_WEIGHTS } from './config.js';
import { ValidationError } from '@tip/domain';

const basePerp = {
  riskPercent: 0.01,
  minRR: 1.5,
  maxConcurrentPositions: 1, // one coin at a time per perp agent — operator preference
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
  it('rejects maxConcurrentPositions != 1 (perp — operator preference; one coin at a time)', () => {
    expect(() => validateScoringConfig({ ...basePerp, maxConcurrentPositions: 2 }, 'perp')).toThrow(ValidationError);
  });

  it('rejects maxConcurrentPositions != 1 (memecoin — §32 domain rule)', () => {
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

describe('DEFAULT_AGENT_WEIGHTS (Part II §9 / Part III §3)', () => {
  it('each domain\'s default weights sum to exactly 1.00', () => {
    for (const domain of ['perp', 'memecoin'] as const) {
      const sum = Object.values(DEFAULT_AGENT_WEIGHTS[domain]).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it('both domains weight Historical Edge at the plan\'s 5%', () => {
    expect(DEFAULT_AGENT_WEIGHTS.perp.historical_edge).toBe(0.05);
    expect(DEFAULT_AGENT_WEIGHTS.memecoin.historical_edge).toBe(0.05);
  });

  it('the perp table matches Part III §3 row-for-row', () => {
    expect(DEFAULT_AGENT_WEIGHTS.perp).toEqual({
      'perp.momentum': 0.2, 'perp.open_interest': 0.2, 'perp.market_regime': 0.15,
      'perp.liquidation': 0.15, 'perp.funding': 0.1, 'perp.positioning': 0.1,
      volume: 0.05, historical_edge: 0.05,
    });
  });

  it('the memecoin table matches Part II §9 row-for-row', () => {
    expect(DEFAULT_AGENT_WEIGHTS.memecoin).toEqual({
      'memecoin.smart_money': 0.25, 'memecoin.convergence': 0.2, early_entry: 0.15,
      'memecoin.momentum': 0.15, 'memecoin.token_quality': 0.1, 'memecoin.market_regime': 0.05,
      freshness: 0.05, historical_edge: 0.05,
    });
  });

  it('validateScoringConfig accepts a config built from the defaults', () => {
    const cfg = validateScoringConfig({
      riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
      agentWeights: DEFAULT_AGENT_WEIGHTS.perp,
      signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
    }, 'perp');
    expect(cfg.agentWeights.historical_edge).toBe(0.05);
  });
});
