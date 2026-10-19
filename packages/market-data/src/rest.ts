import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../../core/src/index.js';
import { marketKey, marketSchema, systemClock } from '../../core/src/index.js';
import {
  candleSchema,
  decimalString,
  epoch,
  intervals,
  durations,
  type Instrument,
  type Candle,
  type Market,
  type Timeframe,
} from './contracts.js';
export type Fetch = typeof fetch;
const envelope = z.object({
  retCode: z.number(),
  retMsg: z.string(),
  time: epoch,
  result: z.unknown(),
});
const positive = decimalString.refine((v) => Number(v) > 0);
export class BybitRest {
  constructor(
    private fetcher: Fetch = fetch,
    private clock: Clock = systemClock,
    private baseUrl = 'https://api.bybit.com',
    private pageSize = 1000,
    private ttlMs = 3600000,
  ) {
    if (pageSize < 1 || pageSize > 1000) throw Error('Invalid page size');
  }
  private async get(path: string, params: Record<string, string>) {
    const url = new URL(path, this.baseUrl);
    url.search = new URLSearchParams(params).toString();
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.fetcher(url, {
          signal: AbortSignal.timeout(8000),
        });
        if (r.status === 429 || r.status >= 500) {
          if (attempt === 2) throw Error(`Bybit HTTP ${r.status}`);
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(
                2000,
                Number(r.headers.get('retry-after') ?? 0) * 1000,
              ) || 200 * 2 ** attempt,
            ),
          );
          continue;
        }
        if (!r.ok) throw Error(`Bybit HTTP ${r.status}`);
        const body = envelope.parse(await r.json());
        if (body.retCode !== 0)
          throw Error(`Bybit rejected public request: ${body.retCode}`);
        return body;
      } catch (e) {
        last = e;
        if (attempt === 2) throw e;
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
    throw last;
  }
  async instrument(input: Market): Promise<Instrument> {
    const market = marketSchema.parse(input),
      symbol = market.baseAsset + market.quoteAsset,
      category = market.marketType === 'SPOT' ? 'spot' : 'linear';
    const response = await this.get('/v5/market/instruments-info', {
      category,
      symbol,
    });
    const result = z
      .object({
        category: z.literal(category),
        list: z.array(z.record(z.string(), z.unknown())),
      })
      .parse(response.result);
    const raw = result.list.find(
      (r) =>
        r.symbol === symbol &&
        r.baseCoin === market.baseAsset &&
        r.quoteCoin === market.quoteAsset &&
        r.status === 'Trading',
    );
    if (
      !raw ||
      (market.marketType === 'LINEAR_PERPETUAL' &&
        raw.contractType !== 'LinearPerpetual')
    )
      throw Error('Requested trading instrument not found');
    const price = z.object({ tickSize: positive }).parse(raw.priceFilter);
    const lot = z.record(z.string(), z.unknown()).parse(raw.lotSizeFilter);
    const quantityStep = positive.parse(
      market.marketType === 'SPOT' ? lot.basePrecision : lot.qtyStep,
    );
    const minQuantity = positive.parse(lot.minOrderQty);
    const minNotional = positive.parse(
      market.marketType === 'SPOT' ? lot.minOrderAmt : lot.minNotionalValue,
    );
    const maxLeverage =
      market.marketType === 'SPOT'
        ? '1'
        : positive.parse(
            z.record(z.string(), z.unknown()).parse(raw.leverageFilter)
              .maxLeverage,
          );
    const verifiedAt = this.clock.now().getTime();
    return {
      market,
      marketKey: marketKey(market),
      symbol,
      specVersion: createHash('sha256')
        .update(JSON.stringify(raw))
        .digest('hex'),
      verifiedAt,
      expiresAt: verifiedAt + this.ttlMs,
      tickSize: price.tickSize,
      quantityStep,
      minQuantity,
      minNotional,
      maxLeverage,
      raw,
    };
  }
  async candles(
    instrument: Instrument,
    timeframe: Timeframe,
    start: number,
    end: number,
    asOf: number,
  ): Promise<Candle[]> {
    const d = durations[timeframe];
    if (start % d || end % d || start >= end || (end - start) / d > 100000)
      throw Error('Invalid bounded candle range');
    const found = new Map<number, Candle>();
    let cursor = end - 1;
    for (let page = 0; cursor >= start && page < 10000; page++) {
      const body = await this.get('/v5/market/kline', {
        category: instrument.market.marketType === 'SPOT' ? 'spot' : 'linear',
        symbol: instrument.symbol,
        interval: intervals[timeframe],
        start: String(start),
        end: String(cursor),
        limit: String(this.pageSize),
      });
      const result = z
        .object({
          symbol: z.literal(instrument.symbol),
          category: z.literal(
            instrument.market.marketType === 'SPOT' ? 'spot' : 'linear',
          ),
          list: z.array(
            z.tuple([
              z.string(),
              decimalString,
              decimalString,
              decimalString,
              decimalString,
              decimalString,
              z.string(),
            ]),
          ),
        })
        .parse(body.result);
      if (!result.list.length) {
        cursor = start - 1;
        break;
      }
      const observedAt = this.clock.now().getTime(),
        cutoff = Math.min(asOf, body.time, observedAt);
      let oldest = Infinity;
      for (const row of result.list) {
        const openTime = epoch.parse(Number(row[0]));
        oldest = Math.min(oldest, openTime);
        if (openTime < start || openTime >= end || openTime + d > cutoff)
          continue;
        const c = candleSchema.parse({
          marketKey: instrument.marketKey,
          timeframe,
          openTime,
          closeTime: openTime + d,
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[5],
          isClosed: true,
          source: 'BYBIT_REST',
          observedAt,
          availableAt: observedAt,
        });
        const previous = found.get(openTime);
        if (
          previous &&
          JSON.stringify({ ...previous, observedAt: 0, availableAt: 0 }) !==
            JSON.stringify({ ...c, observedAt: 0, availableAt: 0 })
        )
          throw Error('Conflicting candle in REST pagination');
        found.set(openTime, c);
      }
      if (oldest > cursor) throw Error('REST pagination made no progress');
      cursor = oldest - 1;
    }
    if (cursor >= start) throw Error('REST pagination exceeded safety bound');
    return [...found.values()].sort((a, b) => a.openTime - b.openTime);
  }
}
