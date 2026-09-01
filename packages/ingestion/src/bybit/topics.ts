/**
 * Bybit v5 topic strings and the Timeframe↔interval mapping (Part III §5). Kept in one place
 * so the mapping is defined exactly once and round-trips (a raw kline message reports its Bybit
 * interval, which we map back to our Timeframe).
 */
import type { Timeframe, MarketSymbol } from '@tip/domain';

/** Our Timeframe → Bybit's kline interval token. */
const TF_TO_INTERVAL: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
};

const INTERVAL_TO_TF: Record<string, Timeframe> = Object.fromEntries(
  Object.entries(TF_TO_INTERVAL).map(([tf, iv]) => [iv, tf as Timeframe]),
) as Record<string, Timeframe>;

/** Candle duration in ms — used to derive closeTime deterministically in both WS and REST paths. */
const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function timeframeMs(tf: Timeframe): number {
  return TF_MS[tf];
}

export function toBybitInterval(tf: Timeframe): string {
  return TF_TO_INTERVAL[tf];
}

export function fromBybitInterval(iv: string): Timeframe {
  const tf = INTERVAL_TO_TF[iv];
  if (!tf) throw new Error(`unknown Bybit kline interval "${iv}"`);
  return tf;
}

// ── Topic builders ────────────────────────────────────────────
export const klineTopic = (tf: Timeframe, symbol: MarketSymbol): string =>
  `kline.${toBybitInterval(tf)}.${symbol}`;
export const tickerTopic = (symbol: MarketSymbol): string => `tickers.${symbol}`;
export const liquidationTopic = (symbol: MarketSymbol): string => `liquidation.${symbol}`;
// Present for completeness; not subscribed until the tick monitor lands (later milestone).
export const publicTradeTopic = (symbol: MarketSymbol): string => `publicTrade.${symbol}`;
export const orderbookTopic = (depth: number, symbol: MarketSymbol): string =>
  `orderbook.${depth}.${symbol}`;

/** Parse a `kline.{iv}.{symbol}` topic back into its parts. */
export function parseKlineTopic(topic: string): { timeframe: Timeframe; symbol: MarketSymbol } {
  const [kind, iv, symbol] = topic.split('.');
  if (kind !== 'kline' || !iv || !symbol) throw new Error(`not a kline topic: "${topic}"`);
  return { timeframe: fromBybitInterval(iv), symbol: symbol as MarketSymbol };
}

/** The topic's kind prefix (`kline` / `tickers` / `liquidation` / ...). */
export function topicKind(topic: string): string {
  return topic.split('.')[0] ?? '';
}
