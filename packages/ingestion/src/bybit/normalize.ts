/**
 * Pure raw→normalized functions (§12). No I/O, no clock reads beyond the injected
 * `processingTime` — this is the heavily-tested core of the adapter, and keeping it pure is
 * what makes it testable from fixtures without a socket or a network.
 *
 * Numbers stay as the strings Bybit sends, preserving precision into the `numeric` columns.
 * `closeTime` is derived as `openTime + timeframeMs` in BOTH the WS and REST paths so a live
 * candle and a backfilled one for the same slot are byte-identical (§25 reproducibility).
 */
import type { MarketSymbol, Timeframe } from '@tip/domain';
import { fromBybitInterval, timeframeMs } from './topics.js';
import type {
  NormalizedKline,
  NormalizedTicker,
  NormalizedLiquidation,
  NormalizedAccountRatio,
} from '../provider.js';

// ── Raw shapes (only the fields we read) ──────────────────────
export interface RawWsKline {
  start: number;
  end: number;
  interval: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover?: string;
  confirm: boolean;
  timestamp: number;
}

export interface RawTicker {
  symbol?: string;
  lastPrice?: string;
  markPrice?: string;
  indexPrice?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  openInterest?: string;
}

/**
 * `allLiquidation.{symbol}` payload record (Bybit v5, condensed field names).
 * The topic delivers an ARRAY of these per message — each row is one aggregated liquidation.
 * The legacy `liquidation.{symbol}` topic used verbose fields (symbol/side/size/price/updatedTime)
 * and was removed by Bybit; the old shape is gone from the wire.
 */
export interface RawLiquidation {
  T: number;   // timestamp ms
  s: string;   // symbol
  S: string;   // side, "Buy" | "Sell"
  v: string;   // size
  p: string;   // price
}

export interface RawAccountRatio {
  symbol: string;
  buyRatio: string;
  sellRatio: string;
  timestamp: string | number;
}

// ── WS normalizers ────────────────────────────────────────────

export function normalizeWsKline(
  entry: RawWsKline,
  symbol: MarketSymbol,
  processingTime: string,
): NormalizedKline {
  const timeframe = fromBybitInterval(entry.interval);
  const openTime = new Date(entry.start);
  return {
    symbol,
    timeframe,
    openTime,
    closeTime: new Date(entry.start + timeframeMs(timeframe)),
    open: entry.open,
    high: entry.high,
    low: entry.low,
    close: entry.close,
    volume: entry.volume,
    turnover: entry.turnover ?? null,
    confirm: entry.confirm,
    eventTime: new Date(entry.timestamp).toISOString(),
    processingTime,
  };
}

/**
 * Merge a ticker snapshot/delta over the last-known state for the symbol. Bybit ticker deltas
 * are partial — a delta that omits `fundingRate` must NOT erase the funding we already have, so
 * every field falls back to `prev`.
 */
export function normalizeTicker(
  prev: NormalizedTicker | undefined,
  raw: RawTicker,
  symbol: MarketSymbol,
  tsMs: number,
  processingTime: string,
): NormalizedTicker {
  const pick = (next: string | undefined, previous: string | null | undefined): string | null =>
    next ?? previous ?? null;
  return {
    symbol,
    lastPrice: pick(raw.lastPrice, prev?.lastPrice),
    markPrice: pick(raw.markPrice, prev?.markPrice),
    indexPrice: pick(raw.indexPrice, prev?.indexPrice),
    fundingRate: pick(raw.fundingRate, prev?.fundingRate),
    nextFundingTime: raw.nextFundingTime
      ? new Date(Number(raw.nextFundingTime))
      : (prev?.nextFundingTime ?? null),
    openInterest: pick(raw.openInterest, prev?.openInterest),
    eventTime: new Date(tsMs).toISOString(),
    processingTime,
  };
}

export function normalizeLiquidation(
  raw: RawLiquidation,
  tsMs: number,
  processingTime: string,
): NormalizedLiquidation {
  const time = new Date(raw.T ?? tsMs);
  return {
    symbol: raw.s as MarketSymbol,
    side: raw.S.toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
    size: raw.v,
    price: raw.p,
    time,
    eventTime: time.toISOString(),
    processingTime,
  };
}

// ── REST normalizers ──────────────────────────────────────────

/** One row of `/v5/market/kline` result.list: [start, open, high, low, close, volume, turnover]. */
export function normalizeRestKline(
  row: readonly string[],
  symbol: MarketSymbol,
  timeframe: Timeframe,
  processingTime: string,
): NormalizedKline {
  const [start, open, high, low, close, volume, turnover] = row;
  const startMs = Number(start);
  const openTime = new Date(startMs);
  const closeTime = new Date(startMs + timeframeMs(timeframe));
  return {
    symbol,
    timeframe,
    openTime,
    closeTime,
    open: open!,
    high: high!,
    low: low!,
    close: close!,
    volume: volume!,
    turnover: turnover ?? null,
    confirm: true, // historical rows are always closed candles
    eventTime: closeTime.toISOString(),
    processingTime,
  };
}

export function normalizeAccountRatio(
  raw: RawAccountRatio,
  processingTime: string,
): NormalizedAccountRatio {
  const time = new Date(Number(raw.timestamp));
  const buy = Number(raw.buyRatio);
  const sell = Number(raw.sellRatio);
  const ratio = sell === 0 ? '0' : String(buy / sell);
  return {
    symbol: raw.symbol as MarketSymbol,
    buyRatio: raw.buyRatio,
    sellRatio: raw.sellRatio,
    longShortRatio: ratio,
    time,
    eventTime: time.toISOString(),
    processingTime,
  };
}
