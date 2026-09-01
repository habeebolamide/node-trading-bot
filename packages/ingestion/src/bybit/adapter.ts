/**
 * BybitAdapter — the orchestration that turns the raw Bybit feed into clean internal state:
 * normalize → persist (historical store, §25) → publish domain events (§10). It is the only
 * place that knows both the WS client and the DB/bus; ws.ts/rest.ts/normalize.ts stay ignorant
 * of each other.
 *
 * Event/persist rate is deliberately bounded so the sub-second ticker stream doesn't flood the
 * bus or the DB: only CONFIRMED candles persist+emit; funding emits only when the rate actually
 * changes; OI persists+emits at most once per minute (bucketed). Every ticker message still
 * heartbeats the FeedMonitor, since staleness detection needs the high-frequency signal.
 */
import type { MarketSymbol, Timeframe } from '@tip/domain';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import { marketCandle, fundingRate, openInterest, type Db } from '@tip/database';
import type { NormalizedTicker } from '../provider.js';
import { FeedMonitor } from '../staleness/monitor.js';
import { klineFeedId, TICKERS_FEED, LIQUIDATION_FEED, FIXED_THRESHOLDS_MS, klineThresholdMs } from '../staleness/thresholds.js';
import { klineTopic, tickerTopic, liquidationTopic, parseKlineTopic, topicKind } from './topics.js';
import { normalizeWsKline, normalizeTicker, normalizeLiquidation, type RawWsKline, type RawTicker, type RawLiquidation } from './normalize.js';
import { BybitWsClient, bybitPublicUrl, type BybitWsOptions } from './ws.js';

export interface BybitAdapterOptions {
  bus: EventBus;
  db: Db;
  monitor: FeedMonitor;
  symbols: MarketSymbol[];
  timeframes: Timeframe[];
  testnet?: boolean;
  /** Injectable WS client for tests (defaults to a real BybitWsClient). */
  wsClient?: BybitWsClient;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

export class BybitAdapter {
  private readonly ws: BybitWsClient;
  private readonly tickers = new Map<string, NormalizedTicker>();
  private readonly lastFunding = new Map<string, string>();
  private readonly lastOiBucket = new Map<string, number>();
  private readonly log: (level: 'info' | 'warn', msg: string) => void;

  constructor(private readonly opts: BybitAdapterOptions) {
    this.log = opts.log ?? (() => {});
    const wsOpts: BybitWsOptions = {
      url: bybitPublicUrl(opts.testnet ?? false),
      onMessage: (m) => void this.ingest(m).catch((e) => this.log('warn', `handle failed: ${String(e)}`)),
      log: this.log,
    };
    this.ws = opts.wsClient ?? new BybitWsClient(wsOpts);
  }

  /** Register feeds with the monitor and open the subscriptions. */
  start(): void {
    const { monitor, symbols, timeframes } = this.opts;
    for (const tf of timeframes) monitor.register(klineFeedId(tf), klineThresholdMs(tf));
    monitor.register(TICKERS_FEED, FIXED_THRESHOLDS_MS[TICKERS_FEED]!);
    monitor.register(LIQUIDATION_FEED, FIXED_THRESHOLDS_MS[LIQUIDATION_FEED]!);

    const topics: string[] = [];
    for (const s of symbols) {
      topics.push(tickerTopic(s), liquidationTopic(s));
      for (const tf of timeframes) topics.push(klineTopic(tf, s));
    }
    this.ws.start();
    this.ws.subscribe(topics);
    this.log('info', `bybit adapter started: ${symbols.length} symbols × ${timeframes.length} TFs`);
  }

  stop(): void {
    this.ws.stop();
  }

  /**
   * Route one raw WS message → normalize → persist + publish. Public so tests can drive the
   * pipeline directly from fixtures without a live socket; in production the WS client calls it.
   */
  async ingest(m: { topic: string; type: string; ts: number; data: unknown }): Promise<void> {
    switch (topicKind(m.topic)) {
      case 'kline':
        return this.handleKline(m.topic, m.data);
      case 'tickers':
        return this.handleTicker(m.topic, m.data, m.ts);
      case 'liquidation':
        return this.handleLiquidation(m.data, m.ts);
      default:
        return; // orderbook/publicTrade not subscribed this milestone
    }
  }

  private async handleKline(topic: string, data: unknown): Promise<void> {
    const { timeframe, symbol } = parseKlineTopic(topic);
    this.opts.monitor.heartbeat(klineFeedId(timeframe));
    const now = new Date().toISOString();
    for (const entry of (data as RawWsKline[]) ?? []) {
      const k = normalizeWsKline(entry, symbol, now);
      if (!k.confirm) continue; // never persist/emit a forming candle (§25)
      await this.opts.db
        .insert(marketCandle)
        .values({
          symbol: k.symbol,
          timeframe: k.timeframe,
          openTime: k.openTime,
          closeTime: k.closeTime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
          turnover: k.turnover,
        })
        .onConflictDoNothing();
      await this.opts.bus.publish(QUEUE_NAMES.MARKET_INGESTION, {
        type: EVENT_NAMES.PERP_KLINE_CLOSED,
        eventTime: k.eventTime,
        source: 'bybit-adapter',
        payload: k,
      });
    }
  }

  private async handleTicker(topic: string, data: unknown, ts: number): Promise<void> {
    const raw = (data ?? {}) as RawTicker;
    const symbol = (raw.symbol ?? topic.split('.')[1]) as MarketSymbol;
    const now = new Date().toISOString();
    const merged = normalizeTicker(this.tickers.get(symbol), raw, symbol, ts, now);
    this.tickers.set(symbol, merged);
    this.opts.monitor.heartbeat(TICKERS_FEED);

    // Funding: emit + persist only when the rate actually changes (~8h cadence).
    if (merged.fundingRate !== null && merged.nextFundingTime && this.lastFunding.get(symbol) !== merged.fundingRate) {
      this.lastFunding.set(symbol, merged.fundingRate);
      await this.opts.db
        .insert(fundingRate)
        .values({ symbol, fundingTime: merged.nextFundingTime, rate: merged.fundingRate })
        .onConflictDoNothing();
      await this.opts.bus.publish(QUEUE_NAMES.MARKET_INGESTION, {
        type: EVENT_NAMES.PERP_FUNDING_UPDATED,
        eventTime: merged.eventTime,
        source: 'bybit-adapter',
        payload: { symbol, fundingRate: merged.fundingRate, nextFundingTime: merged.nextFundingTime.toISOString() },
      });
    }

    // OI: persist + emit at most once per minute (bucketed) to bound the sub-second stream.
    if (merged.openInterest !== null) {
      const bucket = Math.floor(ts / 60_000) * 60_000;
      if (this.lastOiBucket.get(symbol) !== bucket) {
        this.lastOiBucket.set(symbol, bucket);
        await this.opts.db
          .insert(openInterest)
          .values({ symbol, snapshotTime: new Date(bucket), oi: merged.openInterest })
          .onConflictDoNothing();
        await this.opts.bus.publish(QUEUE_NAMES.MARKET_INGESTION, {
          type: EVENT_NAMES.PERP_OPEN_INTEREST_UPDATED,
          eventTime: merged.eventTime,
          source: 'bybit-adapter',
          payload: { symbol, openInterest: merged.openInterest, at: new Date(bucket).toISOString() },
        });
      }
    }
  }

  private async handleLiquidation(data: unknown, ts: number): Promise<void> {
    if (!data) return;
    const liq = normalizeLiquidation(data as RawLiquidation, ts, new Date().toISOString());
    this.opts.monitor.heartbeat(LIQUIDATION_FEED);
    await this.opts.bus.publish(QUEUE_NAMES.MARKET_INGESTION, {
      type: EVENT_NAMES.PERP_LIQUIDATION_DETECTED,
      eventTime: liq.eventTime,
      source: 'bybit-adapter',
      payload: liq,
    });
  }
}
