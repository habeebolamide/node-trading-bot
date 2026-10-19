// Illustrative immutable research histories, not downloaded market data or performance claims.
import {
  candleSchema,
  durations,
  type Candle,
  type Timeframe,
} from '../../packages/market-data/src/contracts.js';
import { marketKey } from '../../packages/core/src/index.js';
import { market } from './market.js';
import type { EvaluationInput } from '../../packages/strategies/src/contracts.js';
export const closeTime = Date.UTC(2026, 9, 19, 12, 15);
export type Scenario =
  | 'trend-long'
  | 'trend-short'
  | 'trend-flat'
  | 'trend-conflict'
  | 'mean-long'
  | 'mean-short'
  | 'mean-flat'
  | 'mean-trend';
export function history(
  frame: Timeframe,
  recipe: 'UP' | 'DOWN' | 'OSCILLATING',
  last?: number,
  count = 500,
): Candle[] {
  const d = durations[frame],
    end = Math.floor(closeTime / d) * d;
  return Array.from({ length: count }, (_, i) => {
    const close =
      i === count - 1 && last !== undefined
        ? last
        : recipe === 'UP'
          ? 100 + i * 0.2
          : recipe === 'DOWN'
            ? 200 - i * 0.2
            : 100 + 2 * Math.sin((i * Math.PI) / 4);
    const v = String(Number(close.toFixed(8))),
      openTime = end - (count - i) * d;
    return candleSchema.parse({
      marketKey: marketKey(market),
      timeframe: frame,
      openTime,
      closeTime: openTime + d,
      open: v,
      close: v,
      high: String(Number((close + 0.3).toFixed(8))),
      low: String(Number((close - 0.3).toFixed(8))),
      volume: '10',
      isClosed: true,
      source: 'FIXTURE',
      observedAt: openTime + d + 1000,
      availableAt: openTime + d + 1000,
    });
  });
}
export function strategyInput(scenario: Scenario): EvaluationInput {
  const trend = scenario.startsWith('trend'),
    frame = trend ? '15m' : '5m';
  return {
    botId: '00000000-0000-4000-8000-000000000001',
    accountId: '00000000-0000-4000-8000-000000000002',
    strategyVersionId: '00000000-0000-4000-8000-000000000003',
    configVersion: 1,
    codeHash: 'a'.repeat(64),
    market,
    trigger: {
      type: 'CANDLE_CLOSE',
      timeframe: frame,
      eventTime: closeTime,
      observedAt: closeTime + 2000,
    },
    tradingState: 'IDLE',
    dataHealthy: true,
    candles: trend
      ? {
          '15m': history(
            '15m',
            scenario === 'trend-short'
              ? 'DOWN'
              : scenario === 'trend-flat'
                ? 'OSCILLATING'
                : 'UP',
          ),
          '1h': history(
            '1h',
            scenario === 'trend-short' || scenario === 'trend-conflict'
              ? 'DOWN'
              : scenario === 'trend-flat'
                ? 'OSCILLATING'
                : 'UP',
          ),
        }
      : {
          '5m': history(
            '5m',
            scenario === 'mean-trend' ? 'UP' : 'OSCILLATING',
            scenario === 'mean-long'
              ? 88
              : scenario === 'mean-short'
                ? 108
                : undefined,
          ),
        },
  };
}
