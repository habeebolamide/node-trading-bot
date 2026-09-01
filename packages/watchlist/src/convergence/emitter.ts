/**
 * The convergence consumer/emitter (Part II §5, §9a). Subscribes to
 * `memecoin.wallet.buy.detected` on SIGNAL_PROCESSING; every buy goes into the per-mint batcher.
 * When a mint's window closes, aggregate over the active clusters (m3-funder-clustering) and
 * publish `memecoin.wallet.convergence.detected` with the full evidence package the Convergence
 * Agent (§40.8, M4) will consume.
 *
 * The batching window default is 5000ms (§9a placeholder). The M2-seed-analysis result tunes it
 * eventually; for M3 it lives here so the module is self-contained until §40's ScoringConfig lands.
 */
import type { DomainEvent } from '@tip/domain';
import type { Db } from '@tip/database';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import { activeClusterMap } from '../clustering/recompute.js';
import { Batcher } from './batching.js';
import { aggregate, type Buy, type ConvergenceResult } from './aggregator.js';

/** Placeholder default per §9a; tune via seed-analysis, wire into ScoringConfig at M4. */
export const DEFAULT_BATCHING_WINDOW_MS = 5000;

/** Payload shape published by BuyDetector (m3-watchlist). */
interface BuyPayload {
  wallet: string;
  walletScore: number;
  mint: string;
  amountSol: string;
  tokenAmount: string;
  blockTime: string;
  signature: string;
  slot: number | null;
}

export interface ConvergenceEmitterDeps {
  db: Db;
  bus: EventBus;
  batchingWindowMs?: number;
  /** Injectable for tests — reads the current wallet→cluster map. */
  loadClusterMap?: () => Promise<Map<string, string>>;
  log?: (msg: string, meta?: unknown) => void;
  /** Injectable timers (tests can drive them synchronously). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Set up the batcher wired to publish a convergence event on window close. Returns the batcher
 * plus a handler for the queue consumer, so tests can drive events directly without BullMQ.
 */
export function createConvergenceEmitter(deps: ConvergenceEmitterDeps): {
  batcher: Batcher;
  handler: (event: DomainEvent) => Promise<void>;
} {
  const log = deps.log ?? (() => {});
  const windowMs = deps.batchingWindowMs ?? DEFAULT_BATCHING_WINDOW_MS;
  const loadClusters = deps.loadClusterMap ?? (() => activeClusterMap(deps.db));

  const emit = async (mint: string, buys: Buy[]): Promise<void> => {
    const clusters = await loadClusters();
    const result: ConvergenceResult = aggregate(buys, clusters, { batchingWindowMs: windowMs });
    // Emit even single-cluster / single-wallet batches (§40.8 — "still gets scored").
    const [firstBuy] = buys;
    if (!firstBuy) return;
    const batchOpenedAt = new Date(
      Math.min(...buys.map((b) => new Date(b.blockTime).getTime())),
    ).toISOString();
    const batchClosedAt = new Date().toISOString();
    await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
      type: EVENT_NAMES.MEMECOIN_WALLET_CONVERGENCE_DETECTED,
      eventTime: batchClosedAt,
      source: 'convergence',
      payload: {
        mint,
        batchOpenedAt,
        batchClosedAt,
        batchingWindowMs: windowMs,
        buys,
        convergenceScore: result.convergenceScore,
        independentClusterCount: result.independentClusterCount,
        timeCompression: result.timeCompression,
        perCluster: result.perCluster,
      },
    });
    log('memecoin.wallet.convergence.detected', {
      mint,
      buys: buys.length,
      independentClusters: result.independentClusterCount,
      score: result.convergenceScore,
    });
  };

  const batcher = new Batcher({
    batchingWindowMs: windowMs,
    onClose: emit,
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
  });

  const handler = async (event: DomainEvent): Promise<void> => {
    if (event.type !== EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED) return;
    const p = event.payload as BuyPayload;
    const buy: Buy = {
      wallet: p.wallet,
      walletScore: p.walletScore,
      amountSol: p.amountSol,
      tokenAmount: p.tokenAmount,
      blockTime: p.blockTime,
      signature: p.signature,
    };
    batcher.admit(p.mint, buy);
  };

  return { batcher, handler };
}

/** Register the emitter as a queue consumer. Returns the batcher (for shutdown drain). */
export function registerConvergenceEmitter(deps: ConvergenceEmitterDeps): {
  worker: ReturnType<EventBus['createWorker']>;
  batcher: Batcher;
} {
  const { batcher, handler } = createConvergenceEmitter(deps);
  const worker = deps.bus.createWorker(QUEUE_NAMES.SIGNAL_PROCESSING, handler);
  return { worker, batcher };
}
