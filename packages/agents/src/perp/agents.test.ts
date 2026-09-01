import { describe, it, expect } from 'vitest';
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext } from '@tip/trading-agents';
import { perpLiquidationAgent } from './liquidation.js';
import { perpPositioningAgent, scoreFromLSRatio } from './positioning.js';
import { _fundingScoreFromPercentile } from './funding.js';
import { volumeSignedDirection } from './features/volume.js';
import { historicalEdgeStub } from './features/historical-edge-stub.js';

const dummyCtx = {} as unknown as AgentContext;
function event<T>(type: string, payload: T): DomainEvent<T> {
  return { id: 'e', type, version: 1, eventTime: 't', processingTime: 't', source: 's', payload };
}

describe('perp.liquidation (§40.4)', () => {
  const base = (over: Record<string, unknown> = {}) => event(EVENT_NAMES.PERP_LIQUIDATION_DETECTED, {
    symbol: 'BTCUSDT', side: 'SELL' as const, size: '1', price: '50000', time: 't', imbalance: 0.7, intensityRatio: 2.5, ...over,
  });
  it('LONG on long-liq cascade (positive imbalance + elevated intensity)', async () => {
    const out = await perpLiquidationAgent.analyze(base(), dummyCtx);
    expect(out!.direction).toBe('LONG');
    expect(out!.score).toBeGreaterThan(0);
  });
  it('SHORT on short-liq cascade', async () => {
    const out = await perpLiquidationAgent.analyze(base({ imbalance: -0.8 }), dummyCtx);
    expect(out!.direction).toBe('SHORT');
  });
  it('pure intensity spike (no imbalance) → NEUTRAL with risk flag', async () => {
    const out = await perpLiquidationAgent.analyze(base({ imbalance: 0.1, intensityRatio: 5 }), dummyCtx);
    expect(out!.direction).toBe('NEUTRAL');
    expect((out!.features as { riskFlag: string }).riskFlag).toBe('HIGH_LIQ_SPIKE');
  });
  it('flat market (low intensity, low imbalance) → NEUTRAL, low confidence', async () => {
    const out = await perpLiquidationAgent.analyze(base({ imbalance: 0.1, intensityRatio: 0.5 }), dummyCtx);
    expect(out!.direction).toBe('NEUTRAL');
    expect(out!.confidence).toBeLessThan(0.5);
  });
  it('single-event fallback (no rollup fields) → uses side for imbalance sign', async () => {
    const out = await perpLiquidationAgent.analyze(event(EVENT_NAMES.PERP_LIQUIDATION_DETECTED, {
      symbol: 'BTCUSDT', side: 'SELL' as const, size: '1', price: '50000', time: 't',
    }), dummyCtx);
    expect(out).not.toBeNull();
  });
});

describe('perp.positioning (§40.6)', () => {
  it('scoreFromLSRatio: ratio 1.0 → 0; 2.0 → −1 (contrarian short); 0.5 → +1 (contrarian long)', () => {
    expect(scoreFromLSRatio(1.0)).toBe(-0);
    expect(scoreFromLSRatio(2.0)).toBe(-1);
    expect(scoreFromLSRatio(0.5)).toBe(1);
    expect(scoreFromLSRatio(4.0)).toBe(-1); // capped
  });
  it('emits SHORT for crowded longs', async () => {
    const out = await perpPositioningAgent.analyze(event(EVENT_NAMES.PERP_POSITIONING_POLLED, {
      symbol: 'BTCUSDT', buyRatio: '0.7', sellRatio: '0.3', longShortRatio: '2.33', time: 't',
    }), dummyCtx);
    expect(out!.direction).toBe('SHORT');
  });
  it('null for invalid ratio', async () => {
    const out = await perpPositioningAgent.analyze(event(EVENT_NAMES.PERP_POSITIONING_POLLED, {
      symbol: 'BTCUSDT', buyRatio: '0', sellRatio: '0', longShortRatio: '0', time: 't',
    }), dummyCtx);
    expect(out).toBeNull();
  });
});

describe('perp.funding scoring (§40.5)', () => {
  it('symmetric-contrarian mapping across percentile buckets', () => {
    expect(_fundingScoreFromPercentile(0.95)).toBeLessThanOrEqual(-0.7);
    expect(_fundingScoreFromPercentile(0.80)).toBeGreaterThan(-0.7);
    expect(_fundingScoreFromPercentile(0.80)).toBeLessThan(0);
    expect(_fundingScoreFromPercentile(0.50)).toBe(0);
    expect(_fundingScoreFromPercentile(0.20)).toBeGreaterThan(0);
    expect(_fundingScoreFromPercentile(0.05)).toBeGreaterThanOrEqual(0.7);
  });
});

describe('perp features', () => {
  it('volumeSignedDirection: buffer < 10 → 0', () => {
    expect(volumeSignedDirection([])).toBe(0);
  });
  it('all-green candles with equal volume → +1', () => {
    const cs = Array.from({ length: 10 }, () => ({ open: 100, close: 101, volume: 1 }));
    expect(volumeSignedDirection(cs)).toBe(1);
  });
  it('all-red candles → -1', () => {
    const cs = Array.from({ length: 10 }, () => ({ open: 100, close: 99, volume: 1 }));
    expect(volumeSignedDirection(cs)).toBe(-1);
  });
  it('historicalEdgeStub returns INSUFFICIENT with score 0', () => {
    expect(historicalEdgeStub()).toEqual({ evidence: 'INSUFFICIENT', score: 0, ciWidth: null });
  });
});
