/**
 * BuyDetector — the bridge between raw wallet ingestion (M1) and memecoin signal generation (M3+).
 * Consumes `wallet.transaction.detected` on the wallet-analysis queue; for each event:
 *   1. drop if the wallet isn't actively watched
 *   2. drop if action !== 'BUY'
 *   3. lookup wallet score AS OF the block time (walletScoreAsOf, rule 21 — a wallet not rated
 *      then must not become "smart money" for a historical event)
 *   4. drop if UNRATED at that time
 *   5. publish `memecoin.wallet.buy.detected` with { wallet, walletScore, mint, amounts, times }
 *
 * The rated-at-T check via walletScoreAsOf is the same discipline the seed-scoring already uses —
 * it's what keeps live/replay indistinguishable and prevents look-ahead when we backfill an
 * agent's decisions later.
 */
import type { DomainEvent } from '@tip/domain';
import type { Db } from '@tip/database';
import type { EventBus } from '@tip/events';
import { EVENT_NAMES, QUEUE_NAMES } from '@tip/events';
import { walletScoreAsOf } from '@tip/wallets';
import type { Watchlist } from './store.js';

/** Payload shape of a `wallet.transaction.detected` event (as emitted by the Helius ingestor). */
interface WalletTxPayload {
  wallet: string;
  action: 'BUY' | 'SELL';
  mint: string;
  amountSol: string;
  tokenAmount: string;
  blockTime: string; // ISO
  signature: string;
  slot: number | null;
}

export interface BuyDetectorDeps {
  db: Db;
  bus: EventBus;
  watchlist: Watchlist;
  log?: (msg: string, meta?: unknown) => void;
}

/**
 * Handler for `wallet.transaction.detected` events. Split from `register()` so tests can drive it
 * directly with a fake event.
 */
export function createBuyDetectorHandler(deps: BuyDetectorDeps): (event: DomainEvent) => Promise<void> {
  const log = deps.log ?? (() => {});
  return async (event: DomainEvent) => {
    if (event.type !== EVENT_NAMES.WALLET_TRANSACTION_DETECTED) return;
    const p = event.payload as WalletTxPayload;
    if (p.action !== 'BUY') return;
    if (!(await deps.watchlist.isWatched(p.wallet))) return;

    const blockTime = new Date(p.blockTime);
    const score = await walletScoreAsOf(deps.db, p.wallet, blockTime);
    if (!score) return; // UNRATED at T — drop; never retroactively promote

    await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
      type: EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED,
      eventTime: p.blockTime,
      source: 'buy-detector',
      payload: {
        wallet: p.wallet,
        walletScore: score.score,
        mint: p.mint,
        amountSol: p.amountSol,
        tokenAmount: p.tokenAmount,
        blockTime: p.blockTime,
        signature: p.signature,
        slot: p.slot,
      },
    });
    log('memecoin.wallet.buy.detected', { wallet: p.wallet, mint: p.mint, score: score.score });
  };
}

/** Register the BuyDetector on the wallet-analysis queue. */
export function registerBuyDetector(deps: BuyDetectorDeps): ReturnType<EventBus['createWorker']> {
  return deps.bus.createWorker(QUEUE_NAMES.WALLET_ANALYSIS, createBuyDetectorHandler(deps));
}
