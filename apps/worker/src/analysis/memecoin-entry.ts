/**
 * Memecoin entry orchestrator (Part II §9a, §10 — audit-2 Batch D #14).
 *
 * The memecoin twin of `entry-orchestrator.ts`. Consumes `signal.created` for memecoin
 * signals, then in one atomic-ish flow:
 *   1. Ownership: `claimToken` on the mint (§9a atomic PK guard) — losing the race records
 *      NO_TRADE and stops.
 *   2. Lifecycle + capacity: BLOCKED/COOLDOWN → refuse; capacity via `openPositionCount`
 *      (memecoin agents are also one-position-per-agent by MVP rule).
 *   3. dailyLossLimit circuit breaker (§37).
 *   4. Plan the trade — `planMemecoin` with the OBSERVED buy price from the signal's
 *      contributing smart-money features (§20 detection-time pricing).
 *   5. Fill — `memecoinBuyFill` against real reserves when available. Rule 25: reserves
 *      unavailable → NO_FILL(RESERVES_UNAVAILABLE), record on the signal, release the token,
 *      never fabricate a price. In this build the raw enhanced-tx isn't threaded through
 *      (that follows on the Helius parser extension), so this path CURRENTLY NO_FILLs every
 *      memecoin entry — which IS the plan's answer, and better than a fabricated fill.
 *   6. Persist: `createPrediction` (immutable, rule 10) + `openPosition` +
 *      `recordOriginatingWallets` from the batch's buys (Part II §10 tracking table).
 *   7. Publish `paper_trade.opened` on the FAST lane (§11 receipt).
 *
 * Release semantics — the token claim is released:
 *   - Immediately on NO_FILL / NO_TRADE here.
 *   - By `releaseTokenByPosition` from the tick-monitor close path.
 *   - By the wallet-exit close path (both routes converge on `closeRemaining`).
 *
 * Anything not built at time of writing is FLAGGED — it degrades to NO_TRADE, never to a
 * fabricated live trade (rule 25).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { paperPortfolio, paperPosition, prediction, scoringConfig, signal, tradingAgent } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES, PRIORITY, QUEUE_NAMES, type EventBus } from '@tip/events';
import { claimToken, releaseToken } from '@tip/agents';
import { planTrade } from '@tip/planner';
import { createPrediction, recordNoTrade, type NoTradeReason } from '@tip/predictions';
import {
  createPortfolio, evaluateDailyLoss, memecoinBuyFill, openPosition, openPositionCount,
  recordOriginatingWallets, type PoolReserves,
} from '@tip/paper-engine';
import { blockAgent, getAgentState, refreshAgentState, type ScoringConfig, type TradingStyle } from '@tip/trading-agents';

interface SignalCreatedPayload {
  signalId: string; tradingAgentId: string; symbol: string; domain: 'perp' | 'memecoin';
  direction: string; compositeScore: number; confidence: number; configVersion: number; expiresAt: string;
}

interface SmartMoneyFeature {
  wallet?: string; walletScore?: number; amountSol?: string; tokenAmount?: string;
  signature?: string;
}

interface ConvergenceFeature { convergenceScore?: number }

interface SignalEvidence {
  contributions?: Array<{
    agent: string; agentVersion: number; weight: number; contribution: number;
    features?: unknown;
  }>;
}

const DEFAULT_STARTING_CASH = 10_000;
const RAYDIUM_FEE = 0.0025; // §20 default (Pump.fun would be 0.01) — future config lift

export interface MemecoinEntryDeps {
  db: Db;
  bus: EventBus;
  /** Injectable reserves resolver — null in MVP → every entry NO_FILLs on reserves (rule 25). */
  resolveReserves?: (mint: string) => Promise<PoolReserves | null>;
  defaultStartingCash?: number;
  log?: (msg: string, meta?: unknown) => void;
}

export function createMemecoinEntryOrchestrator(deps: MemecoinEntryDeps): (event: DomainEvent) => Promise<void> {
  const log = deps.log ?? (() => {});
  const startingCashDefault = deps.defaultStartingCash ?? DEFAULT_STARTING_CASH;

  async function portfolioFor(agentId: string, cfg: ScoringConfig): Promise<{ id: string; cash: number }> {
    const existing = (await deps.db.select({ id: paperPortfolio.id, cash: paperPortfolio.cash })
      .from(paperPortfolio).where(eq(paperPortfolio.tradingAgentId, agentId)).limit(1))[0];
    if (existing) return { id: existing.id, cash: Number(existing.cash) };
    const startingCash = (cfg as { startingBalance?: number }).startingBalance ?? startingCashDefault;
    const p = await createPortfolio(deps.db, { tradingAgentId: agentId, startingCash });
    log('memecoin portfolio created', { agentId, startingCash });
    return { id: p.id, cash: startingCash };
  }

  return async (event: DomainEvent): Promise<void> => {
    if (event.type !== EVENT_NAMES.SIGNAL_CREATED) return;
    const p = event.payload as SignalCreatedPayload;
    if (p.domain !== 'memecoin') return;

    const now = new Date();
    const sig = (await deps.db.select().from(signal).where(eq(signal.id, p.signalId)).limit(1))[0];
    if (!sig || sig.state !== 'ACTIVE') return;
    if (sig.expiresAt <= now) {
      await deps.db.update(signal).set({ state: 'EXPIRED' })
        .where(and(eq(signal.id, p.signalId), eq(signal.state, 'ACTIVE')));
      return;
    }

    const agent = (await deps.db.select().from(tradingAgent).where(eq(tradingAgent.id, sig.tradingAgentId)).limit(1))[0];
    if (!agent || agent.status !== 'active') return;
    const lifecycle = await getAgentState(deps.db, agent.id);
    if (lifecycle && (lifecycle.state === 'BLOCKED' || lifecycle.state === 'COOLDOWN')) {
      log('memecoin entry refused: lifecycle', { signalId: p.signalId, state: lifecycle.state });
      return;
    }
    const cfgRow = (await deps.db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, agent.id), eq(scoringConfig.active, true))).limit(1))[0];
    if (!cfgRow) return;
    const cfg = cfgRow.config as ScoringConfig;

    // §9a token claim — atomic PK write is the concurrency guard. LOSING the race means
    // another agent already holds this mint; record and stop.
    const claim = await claimToken(deps.db, { mint: sig.symbol, tradingAgentId: agent.id });
    if (!claim.claimed) {
      await recordNoTrade(deps.db, { signalId: p.signalId, reason: 'CANNOT_SIZE_SAFELY',
        detail: `token already claimed by ${claim.heldBy}` });
      log('memecoin entry refused: token claimed elsewhere', { mint: sig.symbol, heldBy: claim.heldBy });
      return;
    }

    // Once we own the claim, EVERY failure path must release it — a leaked claim strands the
    // mint globally. try/finally around the rest of the flow.
    try {
      const portfolio = await portfolioFor(agent.id, cfg);
      const open = await openPositionCount(deps.db, portfolio.id);
      if (open >= (cfg.maxConcurrentPositions ?? 1)) {
        log('memecoin entry refused: capacity', { signalId: p.signalId, open });
        await releaseToken(deps.db, sig.symbol);
        return;
      }

      const daily = await evaluateDailyLoss(deps.db, {
        tradingAgentId: agent.id,
        ...(cfg.dailyLossLimit !== undefined ? { dailyLossLimit: cfg.dailyLossLimit } : {}),
        now,
      });
      if (daily.tripped) {
        await blockAgent(deps.db, agent.id, daily.blockUntil);
        await releaseToken(deps.db, sig.symbol);
        log('memecoin entry refused: daily loss', { signalId: p.signalId });
        return;
      }

      // Observed buy price from the signal's contributing smart-money row.
      const evidence = sig.evidence as SignalEvidence;
      const smartMoney = evidence.contributions?.find((c) => c.agent === 'memecoin.smart_money');
      const smf = smartMoney?.features as SmartMoneyFeature | undefined;
      const solIn = Number(smf?.amountSol ?? 0);
      const tokensOut = Number(smf?.tokenAmount ?? 0);
      const observedPrice = tokensOut > 0 && solIn > 0 ? solIn / tokensOut : 0;
      if (observedPrice <= 0) {
        await recordNoTrade(deps.db, { signalId: p.signalId, reason: 'STALE_OR_MISSING_DATA',
          detail: 'no observable buy price on signal contributions' });
        await releaseToken(deps.db, sig.symbol);
        return;
      }

      const plan = await planTrade(
        { symbol: sig.symbol, domain: 'memecoin', direction: 'LONG' },
        {
          style: agent.tradingStyle as TradingStyle, config: cfg, configVersion: cfgRow.version,
          balance: portfolio.cash, fillPrice: observedPrice, plannedAt: now,
        },
      );
      if (plan.kind === 'NO_TRADE') {
        await recordNoTrade(deps.db, { signalId: p.signalId, reason: plan.reason as NoTradeReason, detail: plan.detail });
        await releaseToken(deps.db, sig.symbol);
        log('memecoin NO_TRADE', { signalId: p.signalId, reason: plan.reason });
        return;
      }

      // §20 depth-aware fill — reserves best-effort. Absent → NO_FILL (rule 25).
      const reserves = deps.resolveReserves ? await deps.resolveReserves(sig.symbol).catch(() => null) : null;
      const fill = memecoinBuyFill({
        solIn: plan.setup.notional,
        reserves,
        ...(cfg.maxPoolShare !== undefined ? { maxPoolShare: cfg.maxPoolShare } : {}),
      });
      if (fill.kind === 'NO_FILL') {
        await recordNoTrade(deps.db, { signalId: p.signalId, reason: 'STALE_OR_MISSING_DATA',
          detail: `memecoin ${fill.reason}: ${fill.detail}` });
        await releaseToken(deps.db, sig.symbol);
        log('memecoin NO_FILL', { signalId: p.signalId, reason: fill.reason });
        return;
      }

      // Prediction — atomic ACTIVE→CONSUMED transition.
      const predRes = await createPrediction(deps.db, {
        signalId: p.signalId, tradingAgentId: agent.id, setup: plan.setup,
        signalScore: Number(sig.compositeScore), confidence: Number(sig.confidence),
        direction: 'LONG',
        features: (evidence.contributions ?? []).map((c) => ({
          agent: c.agent, agentVersion: c.agentVersion, weight: c.weight, contribution: c.contribution,
          score: c.weight !== 0 ? c.contribution / c.weight : 0,
        })),
      });
      if (!predRes.created) {
        await releaseToken(deps.db, sig.symbol);
        return;
      }
      const predictionId = predRes.prediction.id;

      // Paper open — use the AMM fill price, not the planner's plan.setup.entry.
      const pos = await openPosition(deps.db, {
        portfolioId: portfolio.id, predictionId, symbol: sig.symbol, domain: 'memecoin', direction: 'LONG',
        entryPrice: fill.price,
        size: fill.tokensOut,
        currentStop: plan.setup.stopLoss,
        takeProfit: plan.setup.takeProfit,
        ladder: (cfg.profitLadder ?? null) as never, // config schema is a superset — validation ran at write
        openedAtEvent: now, openedAtProcessing: now,
      });

      // Re-key the claim to this position so `releaseTokenByPosition` can find it on close.
      await deps.db.update((await import('@tip/database')).activeTokenClaim)
        .set({ positionId: pos.id })
        .where(eq((await import('@tip/database')).activeTokenClaim.mint, sig.symbol));

      // Originating-wallet tracking (Part II §10) — the wallet-exit accumulator lives on these
      // rows. Weights sum to 1.0 across the batch.
      const totalSol = (evidence.contributions ?? [])
        .filter((c) => c.agent === 'memecoin.smart_money' && (c.features as SmartMoneyFeature)?.amountSol)
        .reduce((s, c) => s + Number((c.features as SmartMoneyFeature).amountSol ?? 0), 0);
      const contributions = evidence.contributions ?? [];
      const walletRows = contributions
        .filter((c) => c.agent === 'memecoin.smart_money')
        .map((c) => {
          const f = c.features as SmartMoneyFeature;
          const walletId = f.wallet ?? '';
          const sol = Number(f.amountSol ?? 0);
          const tokenAmount = Number(f.tokenAmount ?? 0);
          return walletId && sol > 0 ? {
            positionId: pos.id, walletId,
            entryUsd: sol, // SOL-denominated as MVP — USD enrichment is a later join
            entryWeight: totalSol > 0 ? sol / totalSol : 1,
            entryScore: f.walletScore ?? null,
            entryTokenAmount: tokenAmount > 0 ? tokenAmount : null,
          } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (walletRows.length > 0) await recordOriginatingWallets(deps.db, walletRows);

      await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
        type: EVENT_NAMES.PREDICTION_CREATED,
        eventTime: now.toISOString(), source: 'memecoin-entry',
        payload: { predictionId, signalId: p.signalId, tradingAgentId: agent.id, symbol: sig.symbol, direction: 'LONG', entryType: 'MARKET' },
      });
      await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
        type: EVENT_NAMES.PAPER_TRADE_OPENED,
        eventTime: now.toISOString(), source: 'memecoin-entry',
        payload: { positionId: pos.id, predictionId, symbol: sig.symbol, direction: 'LONG', price: fill.price, size: fill.tokensOut },
      }, { priority: PRIORITY.FAST });
      await refreshAgentState(deps.db, agent.id, now);
      log('memecoin position opened', { positionId: pos.id, mint: sig.symbol, price: fill.price, tokens: fill.tokensOut });
    } catch (err) {
      // Any unexpected error → release the claim so the mint isn't stranded.
      await releaseToken(deps.db, sig.symbol).catch(() => undefined);
      throw err;
    }
    void inArray; // referenced by future position lookups
  };
}
