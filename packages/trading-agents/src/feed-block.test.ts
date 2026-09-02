import { describe, it, expect } from 'vitest';
import { symbolForFeed } from './feed-block.js';

describe('symbolForFeed', () => {
  it('extracts symbol from klines.<SYMBOL>.<tf>', () => {
    expect(symbolForFeed('klines.BTCUSDT.1h')).toBe('BTCUSDT');
  });
  it('extracts symbol from <SYMBOL>.liquidation', () => {
    expect(symbolForFeed('ETHUSDT.liquidation')).toBe('ETHUSDT');
  });
  it('returns null for a global feed', () => {
    expect(symbolForFeed('tickers')).toBeNull();
  });
});
