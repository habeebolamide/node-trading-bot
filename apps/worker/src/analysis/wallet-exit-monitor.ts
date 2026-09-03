/**
 * Wallet-exit monitor (Part II §10 Design 1 — audit #11). Consumes `wallet.transaction.detected`
 * SELLs and runs `processWalletSell` (@tip/paper-engine): decrement the seller's
 * `current_held_fraction`, log the observation, and — when the accumulator crosses
 * `walletExitThreshold` — full-close the position with `exitReason = WALLET_EXIT`.
 *
 * On a close this publishes `memecoin.wallet.exit.detected` on the FAST lane (§11 — the
 * wallet-exit close is the reaction path's memecoin leg) and moves the agent IN_TRADE → COOLDOWN
 * (§37). Partials below the threshold publish nothing — §10's clean-feed rule: an observation is
 * for the dashboard and learning loop, "never a Telegram ping".
 *
 * This module exports a HANDLER, not a registration: the wallet-analysis queue already feeds the
 * BuyDetector, and two BullMQ workers on one queue would split the jobs between them. main.ts
 * owns the single dispatcher that fans out to both handlers.
 */
import type { Db } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES, PRIORITY, QUEUE_NAMES, type EventBus } from '@tip/events';
import { processWalletSell } from '@tip/paper-engine';
import { enterCooldown } from '@tip/trading-agents';
import { releaseTokenByPosition } from '@tip/agents';

/** Matches NormalizedWalletTx (@tip/ingestion provider seam) — the §12 normalized shape. */
interface WalletTxPayload {
  signature: string;
  wallet: string;
  action: 'BUY' | 'SELL';
  mint: string;
  tokenAmount: string;
  amountSol: string;
  blockTime: string | Date;
}

export interface WalletExitMonitorDeps {
  db: Db;
  bus: EventBus;
  /** COOLDOWN duration after a wallet-exit close — same as the tick monitor's (§37). */
  cooldownMs?: number;
  log?: (msg: string, meta?: unknown) => void;
}

const DEFAULT_COOLDOWN_MS = 5 * 60_000;

export function createWalletExitHandler(deps: WalletExitMonitorDeps): (event: DomainEvent<WalletTxPayload>) => Promise<void> {
  const log = deps.log ?? (() => {});
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  return async (event: DomainEvent<WalletTxPayload>): Promise<void> => {
    if (event.type !== EVENT_NAMES.WALLET_TRANSACTION_DETECTED) return;
    const p = event.payload;
    if (!p || p.action !== 'SELL') return;

    const outcomes = await processWalletSell(deps.db, {
      wallet: p.wallet,
      mint: p.mint,
      signature: p.signature,
      tokenAmount: Number(p.tokenAmount),
      amountSol: Number(p.amountSol),
      blockTime: new Date(p.blockTime),
      processingAt: new Date(),
    });

    for (const o of outcomes) {
      if (o.duplicate) continue; // redelivered webhook — §29 idempotency already absorbed it
      if (o.closed) {
        await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
          type: EVENT_NAMES.MEMECOIN_WALLET_EXIT_DETECTED,
          eventTime: new Date(p.blockTime).toISOString(),
          source: 'wallet-exit-monitor',
          payload: {
            positionId: o.positionId,
            tradingAgentId: o.tradingAgentId,
            mint: p.mint,
            accumulator: o.accumulator,
            threshold: o.threshold,
            closePrice: o.closePrice,
            triggeringWallet: p.wallet,
            txSignature: p.signature,
          },
        }, { priority: PRIORITY.FAST }); // §11 reaction lane — thesis-death exit must not queue
        await releaseTokenByPosition(deps.db, o.positionId); // §9a — free the mint on any exit
        await enterCooldown(deps.db, o.tradingAgentId, cooldownMs, new Date());
        log('wallet-exit close', { positionId: o.positionId, accumulator: o.accumulator });
      } else {
        // Below threshold: observation logged inside processWalletSell; clean-feed rule says
        // nothing is published. The log line is for the operator tailing the worker only.
        log('wallet partial-sell observation', {
          positionId: o.positionId, accumulator: o.accumulator, threshold: o.threshold,
        });
      }
    }
  };
}
