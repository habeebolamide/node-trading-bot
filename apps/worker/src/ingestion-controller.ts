/**
 * IngestionController — reconciles the running Bybit adapter's subscribed universe to what the
 * database actually needs (union of active-agent universes). Cheap to run repeatedly; runs on
 * (a) startup and (b) every `trading_agent.upserted` event published by the API.
 *
 * Design pillars:
 *   - Zero agents = adapter stopped entirely. No WS, no polls, no writes for something no one
 *     reads. The moment the first agent is created, the adapter starts.
 *   - Diff-based, not restart-based: adding a symbol subscribes just its topics, removing one
 *     unsubscribes just its topics. No thundering-herd reconnect on every edit.
 *   - Idempotent: reconcile() can be called any number of times; a no-change tick does nothing.
 *
 * NOT responsible for: Helius (webhook is Helius-hosted — see registerHeliusIngestion is always
 * on so incoming webhooks aren't dropped; the *outbound* wallet watchlist is the Watchlist
 * service's concern and reacts via its own event loop).
 */
import type { EventBus } from '@tip/events';
import { QUEUE_NAMES } from '@tip/events';
import { EVENT_NAMES } from '@tip/events';
import type { BybitAdapter, AccountRatioPoller } from '@tip/ingestion';
import { deriveWatchlist, type Watchlist } from '@tip/trading-agents';
import type { Db } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import type { MarketSymbol } from '@tip/domain';

export interface IngestionControllerOptions {
  readonly db: Db;
  readonly bus: EventBus;
  readonly adapter: BybitAdapter;
  readonly poller: AccountRatioPoller;
  readonly log?: (msg: string, meta?: unknown) => void;
}

export class IngestionController {
  private current: Watchlist = { perp: [], memecoinActive: false };
  private adapterStarted = false;
  private pollerStarted = false;
  private readonly log: (msg: string, meta?: unknown) => void;

  constructor(private readonly opts: IngestionControllerOptions) {
    this.log = opts.log ?? (() => {});
  }

  /**
   * Initial reconcile + subscribe to the CONTROL queue so future upserts are picked up live.
   * Returns the initial watchlist for logging purposes.
   */
  async start(): Promise<Watchlist> {
    // Subscribe first so no event during the first-reconcile window is dropped. BullMQ delivers
    // the earliest-published pending event on connect, so an event that fires between here and
    // reconcile() below still wakes us.
    this.opts.bus.createWorker<{ id: string; domain: string; universe: string[]; status: string }>(
      QUEUE_NAMES.CONTROL,
      async (event: DomainEvent<{ id: string; domain: string; universe: string[]; status: string }>) => {
        if (event.type !== EVENT_NAMES.TRADING_AGENT_UPSERTED) return; // future control events safe
        await this.reconcile();
      },
    );
    await this.reconcile();
    return this.current;
  }

  /** Recompute the desired universe from DB and apply the diff. Safe to call any time. */
  async reconcile(): Promise<void> {
    const next = await deriveWatchlist(this.opts.db);

    // Perp adapter lifecycle: run only when at least one perp agent exists.
    if (next.perp.length === 0 && this.adapterStarted) {
      this.log('perp watchlist emptied — stopping bybit adapter');
      this.opts.adapter.stop();
      this.opts.poller.stop();
      this.adapterStarted = false;
      this.pollerStarted = false;
    } else if (next.perp.length > 0 && !this.adapterStarted) {
      this.log('perp watchlist non-empty — starting bybit adapter', { symbols: next.perp });
      this.opts.adapter.start(); // start with 0 symbols internally; setSymbols below fills them
      this.opts.poller.start();
      this.adapterStarted = true;
      this.pollerStarted = true;
    }

    // Sync the subscribed set to `next.perp` on the running adapter. No-op if unchanged.
    if (this.adapterStarted) {
      this.opts.adapter.setSymbols(next.perp as unknown as MarketSymbol[]);
      this.opts.poller.setSymbols(next.perp as unknown as MarketSymbol[]);
    }

    // Memecoin lifecycle notice — for MVP the webhook processor stays registered (it's the
    // entry point for Helius; it must be up to receive events at all). The watchlist service
    // that pushes wallet subs to Helius reacts on its own via wallet events.
    if (next.memecoinActive !== this.current.memecoinActive) {
      this.log(`memecoin agents ${next.memecoinActive ? 'present' : 'absent'} — helius ingestion ${next.memecoinActive ? 'engaged' : 'idle'}`);
    }

    this.current = next;
  }

  /** For tests + logging. */
  snapshot(): Watchlist { return this.current; }
}
