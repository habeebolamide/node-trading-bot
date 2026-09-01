import { describe, it, expect } from 'vitest';
import { walletAddress } from '@tip/domain';
import { HeliusRestClient } from './rest.js';
import { HELIUS_CANARY_WALLET } from '../watchlist.js';

// Opt-in live test against Helius REST. Needs a key; off by default. Run with
// `HELIUS_LIVE=1 HELIUS_API_KEY=... npm test`.
const KEY = process.env.HELIUS_API_KEY;
const LIVE = process.env.HELIUS_LIVE === '1' && !!KEY;

describe.skipIf(!LIVE)('HeliusRestClient (live, network)', () => {
  it('fetches parseable enhanced transactions for the canary wallet', async () => {
    const client = new HeliusRestClient({ apiKey: KEY! });
    const txs = await client.getAddressTransactions(walletAddress(HELIUS_CANARY_WALLET), { limit: 10 });
    // The parser only keeps SOL-paired SWAPs, so the count may be < 10 (or 0 if none recent) —
    // the assertion is that the call succeeds and returns well-formed normalized rows.
    for (const t of txs) {
      expect(['BUY', 'SELL']).toContain(t.action);
      expect(t.signature).toBeTruthy();
      expect(t.blockTime instanceof Date).toBe(true);
    }
    expect(Array.isArray(txs)).toBe(true);
  }, 20_000);
});
