import { describe, it, expect, vi } from 'vitest';
import { marketSymbol, FatalError, RetryableError } from '@tip/domain';
import { BybitRestClient } from './rest.js';

const SYM = marketSymbol('BTCUSDT');

/** Build a fake fetch returning the given JSON envelope. */
function fakeFetch(envelope: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => envelope,
    }) as unknown as Response,
  );
}

describe('BybitRestClient.getKlines', () => {
  it('parses and returns candles ascending by openTime', async () => {
    const fetchImpl = fakeFetch({
      retCode: 0,
      retMsg: 'OK',
      result: {
        list: [
          ['1700000300000', '105', '106', '104', '105.5', '10', '1050'], // newer first (Bybit order)
          ['1700000000000', '100', '110', '95', '105', '12', '1260'],
        ],
      },
    });
    const client = new BybitRestClient({ fetchImpl });
    const klines = await client.getKlines(SYM, '5m', { limit: 2 });
    expect(klines).toHaveLength(2);
    expect(klines[0]!.openTime.getTime()).toBe(1_700_000_000_000); // sorted ascending
    expect(klines[1]!.openTime.getTime()).toBe(1_700_000_300_000);
    expect(klines[0]!.confirm).toBe(true);
    // query params assembled correctly
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain('interval=5');
    expect(url).toContain('symbol=BTCUSDT');
    expect(url).toContain('category=linear');
  });
});

describe('BybitRestClient error handling', () => {
  it('throws FatalError on a non-retryable retCode', async () => {
    const client = new BybitRestClient({ fetchImpl: fakeFetch({ retCode: 10001, retMsg: 'bad param', result: {} }) });
    await expect(client.getAccountRatio(SYM)).rejects.toBeInstanceOf(FatalError);
  });

  it('throws RetryableError on a rate-limit retCode', async () => {
    const client = new BybitRestClient({ fetchImpl: fakeFetch({ retCode: 10006, retMsg: 'rate limit', result: {} }) });
    await expect(client.getAccountRatio(SYM)).rejects.toBeInstanceOf(RetryableError);
  });

  it('throws RetryableError on a 5xx and FatalError on a 4xx', async () => {
    const c5 = new BybitRestClient({ fetchImpl: fakeFetch({}, { ok: false, status: 503 }) });
    await expect(c5.getAccountRatio(SYM)).rejects.toBeInstanceOf(RetryableError);
    const c4 = new BybitRestClient({ fetchImpl: fakeFetch({}, { ok: false, status: 400 }) });
    await expect(c4.getAccountRatio(SYM)).rejects.toBeInstanceOf(FatalError);
  });
});
