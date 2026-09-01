/**
 * Helius webhook ingestion consumer (Part II §7, §12). Consumes the raw `helius.webhook.received`
 * events the api enqueues, parses them, persists only newly-seen transactions (tx_hash unique,
 * §29), then publishes domain events for the new ones — after the idempotency transaction
 * commits, so a rollback never emits a phantom event, and a re-delivered batch emits nothing new.
 */
import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '@tip/domain';
import { withIdempotency, walletTransaction, token, type Db, type Tx } from '@tip/database';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import type { NormalizedWalletTx } from '../provider.js';
import type { FeedMonitor } from '../staleness/monitor.js';
import { HELIUS_WEBHOOK_FEED, FIXED_THRESHOLDS_MS } from '../staleness/thresholds.js';
import { parseHeliusWebhook } from './parse.js';

export interface HeliusIngestionDeps {
  bus: EventBus;
  db: Db;
  monitor: FeedMonitor;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

interface PersistResult {
  newTxs: NormalizedWalletTx[];
  newMints: string[];
}

/** Persist parsed swaps within the idempotency transaction; report which were newly inserted. */
async function persist(txdb: Tx, parsed: NormalizedWalletTx[]): Promise<PersistResult> {
  const newTxs: NormalizedWalletTx[] = [];
  const newMints: string[] = [];
  for (const n of parsed) {
    const inserted = await txdb
      .insert(walletTransaction)
      .values({
        id: randomUUID(),
        wallet: n.wallet,
        action: n.action,
        mint: n.mint,
        amountSol: n.amountSol,
        tokenAmount: n.tokenAmount,
        amountUsd: null, // M2 enrichment
        blockTime: n.blockTime,
        txHash: n.signature,
        slot: n.slot ?? null,
      })
      .onConflictDoNothing({ target: walletTransaction.txHash })
      .returning({ txHash: walletTransaction.txHash });
    if (inserted.length === 0) continue; // already ingested (a different delivery) — no re-emit
    newTxs.push(n);

    const tokenRow = await txdb
      .insert(token)
      .values({ mint: n.mint })
      .onConflictDoNothing({ target: token.mint })
      .returning({ mint: token.mint });
    if (tokenRow.length > 0) newMints.push(n.mint);
  }
  return { newTxs, newMints };
}

/**
 * The webhook handler as a plain async function — separated from BullMQ wiring so it can be
 * driven directly against a real Postgres in tests (no Redis needed).
 */
export function createHeliusHandler(deps: HeliusIngestionDeps): (event: DomainEvent) => Promise<void> {
  const log = deps.log ?? (() => {});
  return async (event: DomainEvent) => {
    if (event.type !== EVENT_NAMES.HELIUS_WEBHOOK_RECEIVED) return; // not ours; ignore
    deps.monitor.heartbeat(HELIUS_WEBHOOK_FEED); // liveness: a webhook arrived

    const parsed = parseHeliusWebhook(event.payload, new Date().toISOString());
    if (parsed.length === 0) return;

    let result: PersistResult = { newTxs: [], newMints: [] };
    await withIdempotency(deps.db, event.id, async (txdb) => {
      result = await persist(txdb, parsed);
    });

    for (const n of result.newTxs) {
      await deps.bus.publish(QUEUE_NAMES.WALLET_ANALYSIS, {
        type: EVENT_NAMES.WALLET_TRANSACTION_DETECTED,
        eventTime: n.eventTime,
        source: 'helius-adapter',
        payload: n,
      });
    }
    for (const mint of result.newMints) {
      await deps.bus.publish(QUEUE_NAMES.TOKEN_ANALYSIS, {
        type: EVENT_NAMES.TOKEN_ACTIVITY_DETECTED,
        eventTime: new Date().toISOString(),
        source: 'helius-adapter',
        payload: { mint },
      });
    }
    if (result.newTxs.length > 0) {
      log('info', `helius: ingested ${result.newTxs.length} new tx, ${result.newMints.length} new token(s)`);
    }
  };
}

/** Register the Helius consumer on the blockchain-ingestion queue. Returns the worker. */
export function registerHeliusIngestion(deps: HeliusIngestionDeps): ReturnType<EventBus['createWorker']> {
  deps.monitor.register(HELIUS_WEBHOOK_FEED, FIXED_THRESHOLDS_MS[HELIUS_WEBHOOK_FEED]!);
  return deps.bus.createWorker(QUEUE_NAMES.BLOCKCHAIN_INGESTION, createHeliusHandler(deps));
}
