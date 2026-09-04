import { describe, it, expect } from 'vitest';
import { symbolForFeed, domainForFeed } from './feed-block.js';

/**
 * Documents the current (audit-2 corrected) behaviour: registered feed ids in @tip/ingestion
 * are all symbol-less today (`bybit.kline.<tf>`, `bybit.tickers`, `bybit.liquidation`,
 * `bybit.positioning_poll`, `helius.wallet_webhook`, `helius.rest`), so symbolForFeed returns
 * null on every real production id → blockAgentsForStaleFeed blocks every perp agent
 * (conservative). When per-symbol feed ids land, add the shape-specific parses back here.
 */
describe('symbolForFeed', () => {
  it('bybit.kline.<tf> → null (feed id is symbol-less today)', () => {
    expect(symbolForFeed('bybit.kline.1h')).toBeNull();
  });
  it('bybit.tickers / bybit.liquidation / bybit.positioning_poll → null (global)', () => {
    expect(symbolForFeed('bybit.tickers')).toBeNull();
    expect(symbolForFeed('bybit.liquidation')).toBeNull();
    expect(symbolForFeed('bybit.positioning_poll')).toBeNull();
  });
  it('helius.wallet_webhook / helius.rest → null (global)', () => {
    expect(symbolForFeed('helius.wallet_webhook')).toBeNull();
    expect(symbolForFeed('helius.rest')).toBeNull();
  });
  it('forward-compatible: a future per-symbol id like klines.BTCUSDT.1h still parses', () => {
    expect(symbolForFeed('klines.BTCUSDT.1h')).toBe('BTCUSDT');
  });
});

/**
 * Domain gating (bug fix 2026-09-04): helius.* is a MEMECOIN feed; a stale wallet webhook
 * used to block every perp agent through the else-branch's "block all perp" fallback.
 */
describe('domainForFeed', () => {
  it('bybit.* feeds are perp', () => {
    expect(domainForFeed('bybit.kline.1h')).toBe('perp');
    expect(domainForFeed('bybit.tickers')).toBe('perp');
    expect(domainForFeed('bybit.positioning_poll')).toBe('perp');
  });
  it('helius.* feeds are memecoin', () => {
    expect(domainForFeed('helius.wallet_webhook')).toBe('memecoin');
    expect(domainForFeed('helius.rest')).toBe('memecoin');
  });
  it('unknown prefix defaults to both (conservative)', () => {
    expect(domainForFeed('mystery.thing')).toBe('both');
  });
});
