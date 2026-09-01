/**
 * Helius REST client (Part II §7). Wraps the enhanced parsed-transactions endpoint, which
 * returns the same enhanced-tx array the webhook delivers — so history and webhook share one
 * parser (parse.ts). Timeout-guarded (CLAUDE.md); this is the per-address lookup §4's wallet
 * backfill (M2) and the M1 liveness probe both use.
 */
import { RetryableError, FatalError, type WalletAddress } from '@tip/domain';
import { parseHeliusWebhook } from './parse.js';
import type { SolanaDataProvider, NormalizedWalletTx, AddressHistoryQuery } from '../provider.js';

const BASE = 'https://api.helius.xyz';

export interface HeliusRestOptions {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HeliusRestClient implements SolanaDataProvider {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HeliusRestOptions) {
    if (!opts.apiKey) throw new FatalError('HeliusRestClient requires an apiKey (HELIUS_API_KEY)');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Enhanced parsed transactions for an address (newest first, as Helius returns them). */
  async getAddressTransactions(address: WalletAddress, q: AddressHistoryQuery = {}): Promise<NormalizedWalletTx[]> {
    const url = new URL(`${BASE}/v0/addresses/${address}/transactions`);
    url.searchParams.set('api-key', this.apiKey);
    if (q.before) url.searchParams.set('before', q.before);
    if (q.until) url.searchParams.set('until', q.until);
    url.searchParams.set('limit', String(q.limit ?? 100));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { signal: ac.signal });
    } catch (err) {
      throw new RetryableError('helius address-transactions request failed', {
        cause: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const Err = res.status >= 500 ? RetryableError : FatalError;
      throw new Err(`helius address-transactions HTTP ${res.status}`);
    }
    const body = (await res.json()) as unknown;
    return parseHeliusWebhook(body, new Date().toISOString());
  }
}
