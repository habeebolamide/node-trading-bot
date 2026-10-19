import { BybitRest } from './rest.js';
import { BybitPublicFeed } from './feed.js';
import type {
  MarketDataProvider,
  Instrument,
  Market,
  Timeframe,
  FeedEvent,
} from './contracts.js';
export class BybitMarketDataProvider implements MarketDataProvider {
  readonly historicalTrades = {
    coverage: 'RECENT_ONLY',
    ordering: 'EXCHANGE_EVENT_TIME',
    completeRangeReplay: false,
  } as const;
  constructor(
    private rest = new BybitRest(),
    private feed = new BybitPublicFeed(),
  ) {}
  instrument(market: Market) {
    return this.rest.instrument(market);
  }
  candles(
    instrument: Instrument,
    timeframe: Timeframe,
    start: number,
    end: number,
    asOf: number,
  ) {
    return this.rest.candles(instrument, timeframe, start, end, asOf);
  }
  subscribe(
    instrument: Instrument,
    timeframes: Timeframe[],
    listener: (event: FeedEvent) => void,
  ) {
    return this.feed.subscribe(instrument, timeframes, listener);
  }
  close() {
    this.feed.close();
  }
}
