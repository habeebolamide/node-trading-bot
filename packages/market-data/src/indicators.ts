import { createRequire } from 'node:module';
import { z } from 'zod';
import {
  candleSchema,
  durations,
  type Candle,
  type IndicatorRequest,
  type DataRequirements,
  type Timeframe,
} from './contracts.js';
type Result = {
  begIndex: number;
  nbElement: number;
  result: Record<string, number[]>;
};
const native = createRequire(import.meta.url)('talib') as {
  version: string;
  execute(options: Record<string, unknown>): Result;
};
export const talibVersion = native.version;
const period = z.number().int().min(2).max(1000);
export function indicatorOptions(
  request: IndicatorRequest,
): Record<string, number> {
  const p = request.parameters;
  switch (request.name) {
    case 'MACD': {
      const v = z
        .object({
          fastPeriod: period.default(12),
          slowPeriod: period.default(26),
          signalPeriod: period.default(9),
        })
        .strict()
        .parse(p);
      if (v.fastPeriod >= v.slowPeriod)
        throw Error('MACD fast period must be below slow period');
      return {
        optInFastPeriod: v.fastPeriod,
        optInSlowPeriod: v.slowPeriod,
        optInSignalPeriod: v.signalPeriod,
      };
    }
    case 'BBANDS': {
      const v = z
        .object({
          period: period.default(20),
          deviations: z.number().positive().max(10).default(2),
        })
        .strict()
        .parse(p);
      return {
        optInTimePeriod: v.period,
        optInNbDevUp: v.deviations,
        optInNbDevDn: v.deviations,
        optInMAType: 0,
      };
    }
    default: {
      const v = z
        .object({
          period: period.default(
            request.name === 'SMA' || request.name === 'EMA' ? 20 : 14,
          ),
        })
        .strict()
        .parse(p);
      return { optInTimePeriod: v.period };
    }
  }
}
export function warmupFor(request: IndicatorRequest) {
  const options = indicatorOptions(request),
    p = options.optInTimePeriod ?? options.optInSlowPeriod!;
  const count =
    request.name === 'SMA' || request.name === 'BBANDS'
      ? p
      : request.name === 'MACD'
        ? p * 6 + options.optInSignalPeriod!
        : p * (request.name === 'ADX' ? 12 : 6);
  if (
    request.warmupCandles !== undefined &&
    (!Number.isInteger(request.warmupCandles) || request.warmupCandles < count)
  )
    throw Error('Explicit warmup cannot be below indicator stability minimum');
  return Math.max(count, request.warmupCandles ?? 0);
}
export function requiredHistory(
  requirements: DataRequirements,
): Partial<Record<Timeframe, number>> {
  const result = { ...requirements.minClosedCandlesByTimeframe };
  for (const request of requirements.indicators ?? [])
    result[request.timeframe] = Math.max(
      result[request.timeframe] ?? 500,
      warmupFor(request),
    );
  for (const [frame, count] of Object.entries(result))
    if (
      !(frame in durations) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 10000
    )
      throw Error(
        'History requirement must be 1–10000 complete candles per supported timeframe',
      );
  if (!Object.keys(result).length)
    throw Error('At least one timeframe is required');
  return result;
}
export function calculateIndicator(
  input: readonly Candle[],
  request: IndicatorRequest,
  asOf: number,
  availableAsOf: number = asOf,
) {
  const minimum = warmupFor(request),
    d = durations[request.timeframe];
  if (input.length < minimum || input.length > 10000)
    throw Error('INSUFFICIENT_DATA: indicator warmup not met');
  const candles = input.map((c) => candleSchema.parse(c));
  const key = candles[0]!.marketKey;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (
      c.timeframe !== request.timeframe ||
      c.marketKey !== key ||
      c.closeTime > asOf ||
      c.availableAt > availableAsOf ||
      (i > 0 && c.openTime !== candles[i - 1]!.closeTime)
    )
      throw Error('Indicator input has mixed, missing or future data');
  }
  if (candles.at(-1)!.closeTime !== Math.floor(asOf / d) * d)
    throw Error('STALE_DATA: latest completed candle missing');
  const values = (field: 'open' | 'high' | 'low' | 'close' | 'volume') =>
    candles.map((c) => {
      const v = Number(c[field]);
      if (!Number.isFinite(v)) throw Error('Non-finite indicator input');
      return v;
    });
  const options: Record<string, unknown> = {
    name: request.name,
    startIdx: 0,
    endIdx: candles.length - 1,
    ...indicatorOptions(request),
  };
  if (request.name === 'ATR' || request.name === 'ADX') {
    options.high = values('high');
    options.low = values('low');
    options.close = values('close');
  } else options.inReal = values('close');
  const result = native.execute(options);
  if (
    !result ||
    result.nbElement < 1 ||
    Object.values(result.result).some(
      (series) =>
        series.length !== result.nbElement ||
        series.some((v) => !Number.isFinite(v)),
    )
  )
    throw Error('TA-Lib returned invalid output');
  return {
    name: request.name,
    timeframe: request.timeframe,
    asOf,
    availableAsOf,
    inputsThrough: candles.at(-1)!.closeTime,
    begIndex: result.begIndex,
    outputs: result.result,
    latest: Object.fromEntries(
      Object.entries(result.result).map(([k, v]) => [k, v.at(-1)!]),
    ),
    engine: `talib-${native.version}`,
  };
}
