/**
 * Bybit v5 REST client (Part III §5). Public market-data endpoints only — no signing (§5).
 * Every call is timeout-guarded (CLAUDE.md). Provides the historical fetch methods the backfill
 * (change 4) will drive, plus the account-ratio poll used live.
 */
import { RetryableError, FatalError, type MarketSymbol, type Timeframe } from '@tip/domain';
import { toBybitInterval } from './topics.js';
import { normalizeRestKline, normalizeAccountRatio, type RawAccountRatio } from './normalize.js';
import type { MarketDataProvider, NormalizedKline, NormalizedAccountRatio, HistoryQuery } from '../provider.js';

const MAINNET = 'https://api.bybit.com';
const TESTNET = 'https://api-testnet.bybit.com';

// retCodes that are worth retrying (rate limit / transient) vs. fatal (bad params).
const RETRYABLE_RET_CODES = new Set([10006, 10018, 10016]);

export interface FundingPoint {
  readonly symbol: MarketSymbol;
  readonly fundingTime: Date;
  readonly rate: string;
}
export interface OpenInterestPoint {
  readonly symbol: MarketSymbol;
  readonly snapshotTime: Date;
  readonly oi: string;
}

export interface BybitRestOptions {
  testnet?: boolean;
  timeoutMs?: number;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface Envelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

export class BybitRestClient implements MarketDataProvider {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BybitRestOptions = {}) {
    this.base = opts.testnet ? TESTNET : MAINNET;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { signal: ac.signal });
    } catch (err) {
      // network error / abort — transient, safe to retry
      throw new RetryableError(`bybit REST ${path} request failed`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // 5xx transient, 4xx fatal
      const Err = res.status >= 500 ? RetryableError : FatalError;
      throw new Err(`bybit REST ${path} HTTP ${res.status}`);
    }
    const body = (await res.json()) as Envelope<T>;
    if (body.retCode !== 0) {
      const Err = RETRYABLE_RET_CODES.has(body.retCode) ? RetryableError : FatalError;
      throw new Err(`bybit REST ${path} retCode ${body.retCode}: ${body.retMsg}`);
    }
    return body.result;
  }

  /** Historical klines, returned ascending by openTime (chronological, for backfill/replay). */
  async getKlines(symbol: MarketSymbol, timeframe: Timeframe, q: HistoryQuery = {}): Promise<NormalizedKline[]> {
    const result = await this.get<{ list: string[][] }>('/v5/market/kline', {
      category: 'linear',
      symbol,
      interval: toBybitInterval(timeframe),
      start: q.start,
      end: q.end,
      limit: q.limit ?? 200,
    });
    const now = new Date().toISOString();
    return result.list
      .map((row) => normalizeRestKline(row, symbol, timeframe, now))
      .sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  }

  async getFundingHistory(symbol: MarketSymbol, q: HistoryQuery = {}): Promise<FundingPoint[]> {
    const result = await this.get<{ list: { symbol: string; fundingRate: string; fundingRateTimestamp: string }[] }>(
      '/v5/market/funding/history',
      { category: 'linear', symbol, startTime: q.start, endTime: q.end, limit: q.limit ?? 200 },
    );
    return result.list
      .map((r) => ({ symbol, fundingTime: new Date(Number(r.fundingRateTimestamp)), rate: r.fundingRate }))
      .sort((a, b) => a.fundingTime.getTime() - b.fundingTime.getTime());
  }

  async getOpenInterest(
    symbol: MarketSymbol,
    intervalTime: '5min' | '15min' | '30min' | '1h' | '4h' | '1d',
    q: HistoryQuery = {},
  ): Promise<OpenInterestPoint[]> {
    const result = await this.get<{ list: { openInterest: string; timestamp: string }[] }>(
      '/v5/market/open-interest',
      { category: 'linear', symbol, intervalTime, startTime: q.start, endTime: q.end, limit: q.limit ?? 200 },
    );
    return result.list
      .map((r) => ({ symbol, snapshotTime: new Date(Number(r.timestamp)), oi: r.openInterest }))
      .sort((a, b) => a.snapshotTime.getTime() - b.snapshotTime.getTime());
  }

  /** Long/short account ratio (the polled lane, §5). Returns the most recent point. */
  async getAccountRatio(symbol: MarketSymbol, period = '5min'): Promise<NormalizedAccountRatio> {
    const result = await this.get<{ list: RawAccountRatio[] }>('/v5/market/account-ratio', {
      category: 'linear',
      symbol,
      period,
      limit: 1,
    });
    const latest = result.list[0];
    if (!latest) throw new FatalError(`bybit account-ratio returned no data for ${symbol}`);
    return normalizeAccountRatio(latest, new Date().toISOString());
  }
}
