import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { BotInput } from '../../core/src/index.js';
export const timeframeSchema = z.enum(['1m', '5m', '15m', '1h', '4h']);
export type Timeframe = z.infer<typeof timeframeSchema>;
export const durations: Record<Timeframe, number> = {
  '1m': 60000,
  '5m': 300000,
  '15m': 900000,
  '1h': 3600000,
  '4h': 14400000,
};
export const intervals: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
};
export type Market = BotInput['market'];
export const decimalString = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/);
export const epoch = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const candleSchema = z
  .object({
    marketKey: z.string(),
    timeframe: timeframeSchema,
    openTime: epoch,
    closeTime: epoch,
    open: decimalString,
    high: decimalString,
    low: decimalString,
    close: decimalString,
    volume: decimalString,
    isClosed: z.literal(true),
    source: z.enum(['BYBIT_REST', 'BYBIT_WS', 'FIXTURE']),
    observedAt: epoch,
    availableAt: epoch,
  })
  .strict()
  .superRefine((c, ctx) => {
    const d = durations[c.timeframe];
    if (
      c.openTime % d !== 0 ||
      c.closeTime !== c.openTime + d ||
      c.closeTime > c.availableAt ||
      c.availableAt > c.observedAt
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid alignment or candle availability',
      });
    const [o, h, l, v] = [c.open, c.high, c.low, c.close].map(
      (x) => new Decimal(x),
    );
    if (
      !o!.gt(0) ||
      !l!.gt(0) ||
      h!.lt(Decimal.max(o!, v!)) ||
      l!.gt(Decimal.min(o!, v!)) ||
      h!.lt(l!)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid OHLC prices' });
  });
export type Candle = z.infer<typeof candleSchema>;
export type Instrument = {
  market: Market;
  marketKey: string;
  symbol: string;
  specVersion: string;
  verifiedAt: number;
  expiresAt: number;
  tickSize: string;
  quantityStep: string;
  minQuantity: string;
  minNotional: string;
  maxLeverage: string;
  raw: Record<string, unknown>;
};
export type PriceEvent = {
  kind: 'PRICE';
  marketKey: string;
  tradeId: string;
  eventTime: number;
  observedAt: number;
  price: string;
  quantity: string;
  reference: 'LAST';
  side: 'BUY' | 'SELL';
};
export type FeedEvent =
  | PriceEvent
  | { kind: 'CANDLE'; candle: Candle }
  | {
      kind: 'STATUS';
      marketKey: string;
      state: 'CONNECTED' | 'DISCONNECTED' | 'HEARTBEAT' | 'ERROR';
      observedAt: number;
      reason?: string;
    };
export interface MarketDataProvider {
  instrument(market: Market): Promise<Instrument>;
  candles(
    instrument: Instrument,
    timeframe: Timeframe,
    start: number,
    end: number,
    asOf: number,
  ): Promise<Candle[]>;
  subscribe(
    instrument: Instrument,
    timeframes: Timeframe[],
    listener: (event: FeedEvent) => void,
  ): () => void;
  readonly historicalTrades: {
    coverage: 'RECENT_ONLY' | 'RANGE';
    ordering: 'EXCHANGE_EVENT_TIME';
    completeRangeReplay: boolean;
  };
  close(): void;
}
export type Gap = { start: number; end: number };
export interface CandleRepository {
  saveInstrument(instrument: Instrument): Promise<void>;
  instrument(key: string): Promise<Instrument | undefined>;
  read(
    key: string,
    timeframe: Timeframe,
    start: number,
    end: number,
    asOf: number,
  ): Promise<Candle[]>;
  store(candles: Candle[]): Promise<void>;
  gaps(
    key: string,
    timeframe: Timeframe,
    start: number,
    end: number,
    missing: Gap[],
    observedAt: number,
  ): Promise<void>;
  interruption(
    key: string,
    start: number,
    end: number,
    observedAt: number,
  ): Promise<void>;
  checkpoint(key: string): Promise<Record<string, unknown> | undefined>;
  health(
    key: string,
    payload: Record<string, unknown>,
    observedAt: number,
  ): Promise<void>;
}
export function missingRanges(
  candles: readonly Candle[],
  timeframe: Timeframe,
  start: number,
  end: number,
): Gap[] {
  const d = durations[timeframe];
  if (start % d || end % d || start > end)
    throw Error('Unaligned coverage range');
  const have = new Set(candles.map((c) => c.openTime));
  const gaps: Gap[] = [];
  for (let t = start; t < end; t += d) {
    if (have.has(t)) continue;
    const last = gaps.at(-1);
    if (last?.end === t) last.end = t + d;
    else gaps.push({ start: t, end: t + d });
  }
  return gaps;
}
export type IndicatorRequest = {
  name: 'SMA' | 'EMA' | 'RSI' | 'ATR' | 'ADX' | 'MACD' | 'BBANDS';
  timeframe: Timeframe;
  parameters: Record<string, number>;
  warmupCandles?: number;
};
export type DataRequirements = {
  minClosedCandlesByTimeframe: Partial<Record<Timeframe, number>>;
  indicators?: IndicatorRequest[];
};
