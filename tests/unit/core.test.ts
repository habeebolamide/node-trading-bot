import { describe, it, expect } from 'vitest';
import {
  botCreateSchema,
  botUpdateSchema,
  configFromEnv,
  marketSchema,
  marketKey,
} from '../../packages/core/src/index.js';
const id = '00000000-0000-4000-8000-000000000001';
describe('foundation contracts', () => {
  it('defaults to PAPER and rejects LIVE', () => {
    const input = {
      name: 'Research',
      market: {
        exchange: 'bybit',
        marketType: 'SPOT',
        baseAsset: 'btc',
        quoteAsset: 'usdt',
      },
      strategyVersionId: id,
    };
    expect(botCreateSchema.parse(input).executionMode).toBe('PAPER');
    expect(
      botCreateSchema.safeParse({ ...input, executionMode: 'LIVE' }).success,
    ).toBe(false);
  });
  it('normalizes canonical base coin aliases and market identities', () => {
    const m = marketSchema.parse({
      exchange: 'bybit',
      marketType: 'LINEAR_PERPETUAL',
      baseAsset: ' xbt ',
      quoteAsset: 'usdt',
    });
    expect(m.baseAsset).toBe('BTC');
    expect(marketKey(m)).toBe('bybit:LINEAR_PERPETUAL:BTC/USDT');
  });
  it('requires decimal-string percentages and caps individual allocations', () => {
    expect(
      botUpdateSchema.safeParse({
        allocationTargetPercent: 20,
        expectedVersion: 1,
        reason: 'test',
      }).success,
    ).toBe(false);
    expect(
      botUpdateSchema.safeParse({
        allocationTargetPercent: '80.000001',
        expectedVersion: 1,
        reason: 'test',
      }).success,
    ).toBe(false);
  });
  it('fails closed on invalid environment and live runtime settings', () => {
    expect(() =>
      configFromEnv({
        DATABASE_URL: 'postgresql://localhost/test',
        EXECUTION_MODE: 'LIVE',
      }),
    ).toThrow();
    expect(() => configFromEnv({ DATABASE_URL: 'sqlite://test' })).toThrow();
    expect(() =>
      configFromEnv({
        DATABASE_URL: 'postgresql://localhost/test',
        API_PORT: '0',
      }),
    ).toThrow();
  });
});
