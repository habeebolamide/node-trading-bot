/**
 * The polled lane (§5) — long/short account ratio, which Bybit exposes over REST only, not WS.
 * Emits `perp.positioning.polled` and heartbeats the FeedMonitor on each SUCCESSFUL poll; a
 * failed poll deliberately does NOT heartbeat, so the `3 × interval` staleness threshold trips
 * when the endpoint stops responding.
 */
import type { MarketSymbol } from '@tip/domain';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import type { FeedMonitor } from '../staleness/monitor.js';
import { POSITIONING_FEED, positioningPollThresholdMs } from '../staleness/thresholds.js';
import type { BybitRestClient } from './rest.js';

export interface AccountRatioPollerOptions {
  rest: BybitRestClient;
  bus: EventBus;
  monitor: FeedMonitor;
  symbols: MarketSymbol[];
  period?: string; // Bybit period token, default '5min'
  intervalMs?: number; // poll cadence, default 5m
  log?: (level: 'info' | 'warn', msg: string) => void;
}

export class AccountRatioPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly period: string;
  private readonly log: (level: 'info' | 'warn', msg: string) => void;

  constructor(private readonly opts: AccountRatioPollerOptions) {
    this.intervalMs = opts.intervalMs ?? 5 * 60_000;
    this.period = opts.period ?? '5min';
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    this.opts.monitor.register(POSITIONING_FEED, positioningPollThresholdMs(this.intervalMs));
    void this.pollAll(); // fire once immediately
    this.timer = setInterval(() => void this.pollAll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async pollAll(): Promise<void> {
    for (const symbol of this.opts.symbols) {
      try {
        const ratio = await this.opts.rest.getAccountRatio(symbol, this.period);
        await this.opts.bus.publish(QUEUE_NAMES.MARKET_INGESTION, {
          type: EVENT_NAMES.PERP_POSITIONING_POLLED,
          eventTime: ratio.eventTime,
          source: 'bybit-poller',
          payload: ratio,
        });
        this.opts.monitor.heartbeat(POSITIONING_FEED); // only on success
      } catch (err) {
        this.log('warn', `account-ratio poll failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
