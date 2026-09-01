/**
 * Helius REST client (Part II §7). Wraps the enhanced parsed-transactions endpoint, which
 * returns the same enhanced-tx array the webhook delivers — so history and webhook share one
 * parser (parse.ts). Timeout-guarded (CLAUDE.md); this is the per-address lookup §4's wallet
 * backfill (M2) and the M1 liveness probe both use.
 */
import { RetryableError, FatalError, type WalletAddress } from '@tip/domain';
import { parseHeliusWebhook, type RawEnhancedTx } from './parse.js';
import type { SolanaDataProvider, NormalizedWalletTx, AddressHistoryQuery } from '../provider.js';

/** One page of address history: parsed swaps plus the raw cursor/count needed to keep paging. */
export interface AddressPage {
  swaps: NormalizedWalletTx[];
  /** Signature of the last RAW tx in the page — pass as `before` to fetch the next (older) page. */
  lastSignature: string | null;
  /** Number of RAW txs in the page (swaps + non-swaps). `< limit` means end of history. */
  rawCount: number;
  /** The raw Helius enhanced-tx objects for this page (full fields), for debug/inspection. */
  raw: RawEnhancedTx[];
}

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

  /** Raw enhanced-tx array for an address (newest first, as Helius returns them). */
  private async fetchRaw(address: WalletAddress, q: AddressHistoryQuery): Promise<RawEnhancedTx[]> {
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
    return Array.isArray(body) ? (body as RawEnhancedTx[]) : [];
  }

  /** Enhanced parsed swaps for an address (newest first). */
  async getAddressTransactions(address: WalletAddress, q: AddressHistoryQuery = {}): Promise<NormalizedWalletTx[]> {
    return parseHeliusWebhook(await this.fetchRaw(address, q), new Date().toISOString());
  }

  /**
   * One page of history with the raw cursor/count needed to page reliably through a full history
   * (the M2 wallet backfill uses this). Parsing keeps only swaps, so the raw signature/count — not
   * the swap list — must drive pagination, or non-swap-heavy pages would be mis-terminated.
   */
  async getAddressTransactionsPage(address: WalletAddress, q: AddressHistoryQuery = {}): Promise<AddressPage> {
    const raw = await this.fetchRaw(address, q);
    return {
      swaps: parseHeliusWebhook(raw, new Date().toISOString()),
      lastSignature: raw.length > 0 ? (raw[raw.length - 1]!.signature ?? null) : null,
      rawCount: raw.length,
      raw,
    };
  }
}
