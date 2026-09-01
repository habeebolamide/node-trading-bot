import { describe, it, expect } from 'vitest';
import { marketSymbol } from '@tip/domain';
import { BybitRestClient } from './rest.js';

// Opt-in live test against Bybit's public REST (no key needed). Off by default — public but
// network-dependent, so it's not in the default suite. Run with `BYBIT_LIVE=1 npm test`.
const LIVE = process.env.BYBIT_LIVE === '1';

describe.skipIf(!LIVE)('BybitRestClient (live, network)', () => {
  it('fetches recent 1m klines for BTCUSDT', async () => {
    const client = new BybitRestClient({});
    const klines = await client.getKlines(marketSymbol('BTCUSDT'), '1m', { limit: 5 });
    expect(klines.length).toBeGreaterThan(0);
    expect(klines.length).toBeLessThanOrEqual(5);
    for (const k of klines) {
      expect(k.confirm).toBe(true);
      expect(Number(k.high)).toBeGreaterThanOrEqual(Number(k.low));
    }
    // ascending by openTime
    for (let i = 1; i < klines.length; i++) {
      expect(klines[i]!.openTime.getTime()).toBeGreaterThan(klines[i - 1]!.openTime.getTime());
    }
  }, 15_000);

  it('fetches the current long/short account ratio', async () => {
    const client = new BybitRestClient({});
    const r = await client.getAccountRatio(marketSymbol('BTCUSDT'), '5min');
    expect(Number(r.buyRatio)).toBeGreaterThan(0);
    expect(Number(r.sellRatio)).toBeGreaterThan(0);
  }, 15_000);
});
