/**
 * Memecoin swap-tick monitor (Part II §10 — audit-2 Batch D #14).
 *
 * Memecoin has no klines, so the tick source per §10 comment ("memecoin treats each swap as a
 * tick") is `wallet.transaction.detected`. Every BUY or SELL on a mint carries an implied
 * execution price `amountSol / tokenAmount`. This monitor observes those swaps and drives the
 * same exit machinery the perp tick monitor uses:
 *   - profit ladder rungs (§10 gap-up tie-break, but memecoin swaps are point events so a
 *     single swap crosses at most one new rung at a time)
 *   - single-level takeProfit (when no ladder configured)
 *   - stop_loss when the swap price crosses the current stop
 *   - horizon expiry checked on every tick
 *
 * Wallet-exit is handled by the SEPARATE `wallet-exit-monitor` (accumulator-based, Design 1);
 * this monitor only cares about PRICE. The two are complementary — one dumps on thesis death,
 * the other exits on P&L.
 *
 * On close, releases the token claim (§9a — "a claim lives only while the position is held").
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { paperPosition, prediction, scoringConfig, type Db } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES, PRIORITY, QUEUE_NAMES, type EventBus } from '@tip/events';
import { releaseTokenByPosition } from '@tip/agents';
import {
  applyLadderRung, closeRemaining, crossedLadderRungs, evalTick, updateExcursion,
  evaluateDailyLoss, type LadderRungConfig,
} from '@tip/paper-engine';
import { blockAgent, enterCooldown, refreshAgentState } from '@tip/trading-agents';
import { HORIZON_MS } from '@tip/planner';

const COOLDOWN_MS = 5 * 60_000;

interface WalletTxPayload {
  wallet: string; mint: string; action: 'BUY' | 'SELL';
  amountSol: string; tokenAmount: string;
  signature: string; blockTime: string | Date;
}

export interface MemecoinTickDeps {
  db: Db;
  bus: EventBus;
  log?: (msg: string, meta?: unknown) => void;
}

async function ladderFor(db: Db, agentId: string): Promise<readonly LadderRungConfig[] | null> {
  const cfgRow = (await db.select({ config: scoringConfig.config })
    .from(scoringConfig)
    .where(and(eq(scoringConfig.tradingAgentId, agentId), eq(scoringConfig.active, true))).limit(1))[0];
  return ((cfgRow?.config as { profitLadder?: LadderRungConfig[] } | undefined)?.profitLadder) ?? null;
}

async function tripDailyLossIfCrossed(deps: MemecoinTickDeps, agentId: string, now: Date): Promise<void> {
  const cfgRow = (await deps.db.select({ config: scoringConfig.config })
    .from(scoringConfig)
    .where(and(eq(scoringConfig.tradingAgentId, agentId), eq(scoringConfig.active, true))).limit(1))[0];
  const limit = (cfgRow?.config as { dailyLossLimit?: number } | undefined)?.dailyLossLimit;
  if (!limit) return;
  const daily = await evaluateDailyLoss(deps.db, { tradingAgentId: agentId, dailyLossLimit: limit, now });
  if (daily.tripped) {
    await blockAgent(deps.db, agentId, daily.blockUntil);
    (deps.log ?? (() => {}))('memecoin daily loss tripped — agent BLOCKED', { agentId, until: daily.blockUntil });
  }
}

export function createMemecoinTickHandler(deps: MemecoinTickDeps): (event: DomainEvent<WalletTxPayload>) => Promise<void> {
  const log = deps.log ?? (() => {});
  return async (event: DomainEvent<WalletTxPayload>): Promise<void> => {
    if (event.type !== EVENT_NAMES.WALLET_TRANSACTION_DETECTED) return;
    const p = event.payload;
    if (!p?.mint || !p.amountSol || !p.tokenAmount) return;
    const tokenAmount = Number(p.tokenAmount);
    const solAmount = Number(p.amountSol);
    if (tokenAmount <= 0 || solAmount <= 0) return;
    const price = solAmount / tokenAmount;
    const now = new Date(p.blockTime);

    // Every OPEN memecoin position on this mint gets a tick — one swap can only hit one
    // position (one-agent-per-mint via the token-claim), but the query stays symmetric.
    const positions = await deps.db.select({
      id: paperPosition.id, direction: paperPosition.direction, state: paperPosition.state,
      entryPrice: paperPosition.entryPrice, currentStop: paperPosition.currentStop,
      takeProfit: paperPosition.takeProfit, ladderState: paperPosition.ladderState,
      openedAtProcessing: paperPosition.openedAtProcessing,
      predAgentId: prediction.tradingAgentId, horizon: prediction.horizon,
    })
      .from(paperPosition)
      .innerJoin(prediction, eq(prediction.id, paperPosition.predictionId))
      .where(and(
        eq(paperPosition.symbol, p.mint),
        eq(paperPosition.domain, 'memecoin'),
        inArray(paperPosition.state, ['OPEN']),
      ));
    if (positions.length === 0) return;

    for (const pos of positions) {
      const clocks = { fillAtEvent: now, fillAtProcessing: new Date() };
      const dir = pos.direction as 'LONG';
      await updateExcursion(deps.db, pos.id, price);

      const ladderState = (pos.ladderState as { firedRungs?: number[] } | null);
      const horizonMs = HORIZON_MS[pos.horizon as keyof typeof HORIZON_MS] ?? 4 * 3600_000;
      const horizonEndsAt = new Date(pos.openedAtProcessing.getTime() + horizonMs);
      const ladder = await ladderFor(deps.db, pos.predAgentId);

      // Rungs fire in order at the CROSSING price (which for a swap tick is just `price`).
      if (ladder && ladder.length > 0) {
        const rungIdxs = crossedLadderRungs(Number(pos.entryPrice), price, ladder, ladderState?.firedRungs ?? []);
        for (const idx of rungIdxs) {
          const rungPrice = Number(pos.entryPrice) * ladder[idx]!.at;
          await applyLadderRung(deps.db, { positionId: pos.id, rungIndex: idx, rungPrice, rung: ladder[idx]!, clocks });
          log('memecoin ladder rung fired', { positionId: pos.id, rung: idx, price: rungPrice });
        }
      }

      const decision = evalTick({
        entryPrice: Number(pos.entryPrice), currentStop: Number(pos.currentStop),
        takeProfit: pos.takeProfit === null ? null : Number(pos.takeProfit), direction: dir,
        firedRungs: (ladderState?.firedRungs ?? []),
        ladder: ladder && ladder.length > 0 ? ladder : null,
        price, now, horizonEndsAt, walletExitReached: false,
      });

      if (decision.kind === 'STOP_LOSS' || decision.kind === 'TAKE_PROFIT') {
        await closeRemaining(deps.db, { positionId: pos.id, price: decision.price, reason: decision.kind, clocks });
        await releaseTokenByPosition(deps.db, pos.id); // §9a — free the mint on any exit
        await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
          type: decision.kind === 'STOP_LOSS' ? EVENT_NAMES.PAPER_TRADE_SL_HIT : EVENT_NAMES.PAPER_TRADE_TP_HIT,
          eventTime: now.toISOString(), source: 'memecoin-tick',
          payload: { positionId: pos.id, price: decision.price },
        }, { priority: PRIORITY.FAST });
        await enterCooldown(deps.db, pos.predAgentId, COOLDOWN_MS, now);
        await tripDailyLossIfCrossed(deps, pos.predAgentId, now);
        log('memecoin position closed', { positionId: pos.id, reason: decision.kind, price: decision.price });
      } else if (decision.kind === 'HORIZON_EXPIRY') {
        await closeRemaining(deps.db, { positionId: pos.id, price, reason: 'HORIZON_EXPIRY', clocks });
        await releaseTokenByPosition(deps.db, pos.id);
        await enterCooldown(deps.db, pos.predAgentId, COOLDOWN_MS, now);
        await tripDailyLossIfCrossed(deps, pos.predAgentId, now);
        log('memecoin position closed on horizon', { positionId: pos.id });
      }
      // Refresh IN_TRADE state (a rung may have left it OPEN with less size but no full close).
      await refreshAgentState(deps.db, pos.predAgentId, now);
    }
    void sql; // future: horizon-only sweep (positions with no swap flow)
  };
}
