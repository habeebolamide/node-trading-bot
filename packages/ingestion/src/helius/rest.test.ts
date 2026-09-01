import { describe, it, expect, vi } from 'vitest';
import { walletAddress, FatalError, RetryableError } from '@tip/domain';
import { HeliusRestClient } from './rest.js';
import { WSOL_MINT } from './parse.js';

const WALLET = walletAddress('Wa11etAddr1111111111111111111111111111111111');

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body }) as unknown as Response);
}

describe('HeliusRestClient', () => {
  it('throws without an api key', () => {
    expect(() => new HeliusRestClient({ apiKey: '' })).toThrow(FatalError);
  });

  it('parses an enhanced-tx history array via the shared parser', async () => {
    const fetchImpl = fakeFetch([
      {
        type: 'SWAP', feePayer: WALLET, signature: 'S1', timestamp: 1_700_000_000,
        tokenTransfers: [{ toUserAccount: WALLET, mint: 'Mint111', tokenAmount: 42 }],
        nativeTransfers: [{ fromUserAccount: WALLET, amount: 1_000_000_000 }],
      },
      { type: 'UNKNOWN' },
    ]);
    const client = new HeliusRestClient({ apiKey: 'k', fetchImpl });
    const txs = await client.getAddressTransactions(WALLET, { limit: 10 });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.action).toBe('BUY');
    expect(txs[0]!.amountSol).toBe('1');
    // api-key + limit went on the URL
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain('api-key=k');
    expect(url).toContain('limit=10');
  });

  it('splits HTTP errors: 5xx → Retryable, 4xx → Fatal', async () => {
    await expect(
      new HeliusRestClient({ apiKey: 'k', fetchImpl: fakeFetch([], { ok: false, status: 503 }) }).getAddressTransactions(WALLET),
    ).rejects.toBeInstanceOf(RetryableError);
    await expect(
      new HeliusRestClient({ apiKey: 'k', fetchImpl: fakeFetch([], { ok: false, status: 404 }) }).getAddressTransactions(WALLET),
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('keeps WSOL constant exported for callers', () => {
    expect(WSOL_MINT).toMatch(/^So1111/);
  });
});
