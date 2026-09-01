import { marketSymbol, type MarketSymbol, type Timeframe } from '@tip/domain';

/**
 * MVP perp watch set (§30 — BTC/ETH/SOL). Operational infra config, kept as a code constant
 * for now; promotable to a table/env when the universe grows. Not ScoringConfig.
 */
export const DEFAULT_PERP_SYMBOLS: readonly MarketSymbol[] = [
  marketSymbol('BTCUSDT'),
  marketSymbol('ETHUSDT'),
  marketSymbol('SOLUSDT'),
];

/** Timeframes ingested live + backfilled (§30 pre-launch gate lists all six). */
export const DEFAULT_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
