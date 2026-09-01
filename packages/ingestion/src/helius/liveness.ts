/**
 * Helius webhook-liveness probe — the §10 caveat resolution ("must be settled before shipping
 * the Helius adapter"). Push-only webhooks can't be heartbeated directly, so a silent webhook
 * feed is ambiguous: quiet wallets, or a dead subscription? Strategy (b), REST re-check:
 *
 *   - webhook receipt heartbeats `helius.wallet_webhook` (in ingest.ts).
 *   - this probe periodically hits Helius REST for a canary wallet and heartbeats `helius.rest`
 *     whenever REST is reachable.
 *   - the actionable signal (computed by the caller from the monitor): `helius.wallet_webhook`
 *     STALE while `helius.rest` FRESH ⇒ the webhook path is broken, not merely quiet.
 *
 * Reachability is what proves the path alive, so even an empty canary response counts as a
 * successful probe — a failed/timed-out request does not heartbeat, so `helius.rest` itself goes
 * stale when Helius is unreachable.
 */
import { walletAddress } from '@tip/domain';
import type { FeedMonitor } from '../staleness/monitor.js';
import { HELIUS_REST_FEED, heliusRestThresholdMs } from '../staleness/thresholds.js';
import type { HeliusRestClient } from './rest.js';

export interface HeliusLivenessProbeOptions {
  rest: HeliusRestClient;
  monitor: FeedMonitor;
  /** A known-active wallet used purely as a reachability probe. */
  canaryWallet: string;
  intervalMs?: number; // default 5m
  log?: (level: 'info' | 'warn', msg: string) => void;
}

export class HeliusLivenessProbe {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly log: (level: 'info' | 'warn', msg: string) => void;

  constructor(private readonly opts: HeliusLivenessProbeOptions) {
    this.intervalMs = opts.intervalMs ?? 5 * 60_000;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    this.opts.monitor.register(HELIUS_REST_FEED, heliusRestThresholdMs(this.intervalMs));
    void this.probe();
    this.timer = setInterval(() => void this.probe(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async probe(): Promise<void> {
    try {
      await this.opts.rest.getAddressTransactions(walletAddress(this.opts.canaryWallet), { limit: 1 });
      this.opts.monitor.heartbeat(HELIUS_REST_FEED); // reachable → path alive
    } catch (err) {
      this.log('warn', `helius REST liveness probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
