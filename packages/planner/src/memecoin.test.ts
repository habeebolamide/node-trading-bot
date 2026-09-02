import { describe, it, expect } from 'vitest';
import { ValidationError } from '@tip/domain';
import { marketSymbol } from '@tip/domain';
import type { ScoringConfig } from '@tip/trading-agents';
import { planMemecoin } from './memecoin.js';
import { planTrade } from './plan.js';

const baseConfig: ScoringConfig = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1,
  agentWeights: { 'memecoin.smart_money': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2 },
  stopPct: 0.2,
  takeProfitPct: 0.6, // R:R = 0.6/0.2 = 3.0
};

const T = new Date('2026-06-01T00:00:00Z');
const MINT = marketSymbol('MINT_ABC');

describe('planMemecoin (Part II §10)', () => {
  it('MARKET-only, fixed-% stop, no leverage', () => {
    const r = planMemecoin({
      symbol: MINT, direction: 'LONG', style: 'day', config: baseConfig,
      configVersion: 1, balance: 10_000, fillPrice: 1, plannedAt: T,
    });
    expect(r.kind).toBe('TRADE');
    if (r.kind !== 'TRADE') return;
    expect(r.setup.entryType).toBe('MARKET');
    expect(r.setup.stopLoss).toBeCloseTo(0.8, 10); // fill × (1 − stopPct)
    expect(r.setup.takeProfit).toBeCloseTo(1.6, 10);
    expect(r.setup.leverage).toBeNull();
    expect(r.setup.requiredMargin).toBeNull();
    expect(r.setup.horizon).toBe('4h'); // middle of day-style triad (§8)
  });

  it('SHORT is not planable — memecoin is spot / long-only (§18)', () => {
    expect(() => planMemecoin({
      ...({ symbol: MINT, style: 'day', config: baseConfig, configVersion: 1, balance: 10_000, fillPrice: 1, plannedAt: T } as const),
      direction: 'SHORT' as unknown as 'LONG',
    })).toThrow(ValidationError);
  });

  it('NO_TRADE(NO_STOP_DERIVABLE) when stopPct is missing or absurd', () => {
    for (const stopPct of [undefined, 0, 1, 2] as (number | undefined)[]) {
      const cfg = { ...baseConfig, stopPct } as unknown as ScoringConfig;
      const r = planMemecoin({ symbol: MINT, direction: 'LONG', style: 'day', config: cfg, configVersion: 1, balance: 10_000, fillPrice: 1, plannedAt: T });
      expect(r.kind).toBe('NO_TRADE');
    }
  });

  it('TP null when profitLadder is set; R:R against the FIRST rung, not the last', () => {
    const cfg: ScoringConfig = {
      ...baseConfig,
      stopPct: 0.2,
      profitLadder: [
        { at: 2.0, sellFraction: 0.5, postTakeAction: 'move_stop_to_breakeven' },
        { at: 3.0, sellFraction: 0.25 },
        { at: 5.0, sellFraction: 0.15 },
      ],
    };
    delete (cfg as { takeProfitPct?: number }).takeProfitPct;
    const r = planMemecoin({ symbol: MINT, direction: 'LONG', style: 'day', config: cfg, configVersion: 1, balance: 10_000, fillPrice: 1, plannedAt: T });
    expect(r.kind).toBe('TRADE');
    if (r.kind !== 'TRADE') return;
    expect(r.setup.takeProfit).toBeNull();
    // First rung = 2.0 → reward = entry × (2 − 1) = 1; stop distance = 0.2 → R:R = 5.
    // If R:R had been computed against the LAST rung (5.0) it would be 20 — much higher,
    // making laddered setups flatter every gate check.
    expect(r.setup.riskReward).toBeCloseTo(5, 10);
  });

  it('rejects a config with both takeProfitPct and profitLadder — mutually exclusive (Part II §10)', () => {
    const cfg: ScoringConfig = {
      ...baseConfig,
      profitLadder: [{ at: 2, sellFraction: 0.5 }],
    };
    expect(() => planMemecoin({ symbol: MINT, direction: 'LONG', style: 'day', config: cfg, configVersion: 1, balance: 10_000, fillPrice: 1, plannedAt: T }))
      .toThrow(ValidationError);
  });

  it('NO_TRADE(INSUFFICIENT_RR) fires when minRR gates a laddered setup with too tight a first rung', () => {
    const cfg: ScoringConfig = {
      ...baseConfig,
      stopPct: 0.5,                                    // 50% stop
      profitLadder: [{ at: 1.5, sellFraction: 0.5 }],  // first rung reward 50% of entry
    };
    delete (cfg as { takeProfitPct?: number }).takeProfitPct;
    // reward 0.5, stop 0.5 → R:R = 1.0 < minRR 1.5
    const r = planMemecoin({ symbol: MINT, direction: 'LONG', style: 'day', config: cfg, configVersion: 1, balance: 10_000, fillPrice: 1, plannedAt: T });
    expect(r.kind).toBe('NO_TRADE');
    if (r.kind === 'NO_TRADE') expect(r.reason).toBe('INSUFFICIENT_RR');
  });

  it('planTrade rejects a memecoin SHORT signal outright (§18 long-only)', async () => {
    await expect(planTrade(
      { symbol: 'MINT', domain: 'memecoin', direction: 'SHORT' },
      { style: 'day', config: baseConfig, configVersion: 1, balance: 10_000, fillPrice: 1, plannedAt: T },
    )).rejects.toThrow();
  });
});
