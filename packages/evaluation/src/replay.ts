/**
 * The core replay engine (§25, §30 correction — M1, not M6). Iterates the primary-timeframe
 * candles chronologically and hands each step a no-look-ahead data view bound to that bar's
 * close. This is the loop M4–M6 attach agents/signals/predictions to; here it delivers the
 * contract and its determinism (same stored rows → identical step sequence, §25 / Task 7).
 */
import type { MarketSymbol, Timeframe } from '@tip/domain';
import type { Db } from '@tip/database';
import { HistoricalMarketReader } from './reader.js';
import { AsOfMarketData, type Candle } from './asof.js';

export interface ReplayOptions {
  symbol: MarketSymbol;
  /** The timeframe whose closes drive the cursor (the TradingAgent's primary TF, §8). */
  primaryTf: Timeframe;
  from?: Date;
  to?: Date;
}

export interface ReplayStep {
  /** T for this step — the bar's CLOSE time (info is available at close, not open; cf. §21). */
  asOf: Date;
  /** The bar that just closed. */
  bar: Candle;
  /** No-look-ahead view: only data with timestamp ≤ asOf is observable (rule 21). */
  data: AsOfMarketData;
}

export class ReplayEngine {
  private readonly reader: HistoricalMarketReader;

  constructor(private readonly db: Db) {
    this.reader = new HistoricalMarketReader(db);
  }

  /** Yield one step per primary-TF candle, in chronological order. */
  async *replay(opts: ReplayOptions): AsyncGenerator<ReplayStep> {
    const streamRange: { from?: Date; to?: Date } = {};
    if (opts.from) streamRange.from = opts.from;
    if (opts.to) streamRange.to = opts.to;
    for await (const bar of this.reader.streamCandles(opts.symbol, opts.primaryTf, streamRange)) {
      const asOf = bar.closeTime;
      yield { asOf, bar, data: new AsOfMarketData(this.db, asOf) };
    }
  }
}
