/**
 * Feed-staleness thresholds (§10). Platform-wide infra config — NOT ScoringConfig (these are
 * reliability settings, not per-TradingAgent scoring inputs). Values are the §10 table verbatim,
 * in ms, and are meant to be tuned by editing here (one-line change, no redeploy of logic).
 *
 * Kline feeds follow the general rule `threshold = 2 × interval + 30s` — encoded as a function
 * rather than copied per timeframe, so the rule can't drift between rows.
 */
import { timeframeMs } from '../bybit/topics.js';
import type { Timeframe } from '@tip/domain';

const SEC = 1000;
const MIN = 60 * SEC;

/** Fixed-threshold feeds (non-kline, non-poll). */
export const FIXED_THRESHOLDS_MS: Readonly<Record<string, number>> = {
  'bybit.tickers': 5 * SEC,
  'bybit.orderbook': 5 * SEC,
  'bybit.publicTrade': 60 * SEC,
  'bybit.liquidation': 30 * MIN,
  'helius.wallet_webhook': 60 * SEC, // first approximation, §10 caveat (change 3)
};

/** `2 × interval + 30s` (§10 general rule). */
export function klineThresholdMs(tf: Timeframe): number {
  return 2 * timeframeMs(tf) + 30 * SEC;
}

/** `3 × poll interval` (§10). e.g. 5m poll → 15m threshold. */
export function positioningPollThresholdMs(pollIntervalMs: number): number {
  return 3 * pollIntervalMs;
}

// ── Feed-id builders (stable keys the FeedMonitor tracks) ──────
export const klineFeedId = (tf: Timeframe): string => `bybit.kline.${tf}`;
export const TICKERS_FEED = 'bybit.tickers';
export const LIQUIDATION_FEED = 'bybit.liquidation';
export const POSITIONING_FEED = 'bybit.positioning_poll';
