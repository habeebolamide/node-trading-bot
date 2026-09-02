/**
 * Entry orchestrator (§18, §19, §20, §35, §37 — audit-2 finding #1, THE missing link).
 *
 * Until this module, the live pipeline ended at `signal.created` + a recorded Judge decision:
 * `createPrediction` had one caller (the seeder) and `openPosition` had none. This consumer is
 * the §19 "Signal Engine's downstream consumer" that judge-tier.ts always claimed existed:
 * it turns a CONSUMED-able signal into a Prediction and a paper position, under every §35/§37
 * gate the audit found built-but-never-called.
 *
 * FLOW (perp — memecoin gets its own tier in the memecoin batch):
 *   signal.created ──┬─ Judge disabled → proceed with the deterministic direction now.
 *                    └─ Judge enabled → wait for the gate. `judge.evaluation.completed` arrives
 *                       and the gate handler (registered BEFORE this one in the dispatcher) has
 *                       already written `judge_decision`; we act on its action:
 *                         AGREE / DEFER → deterministic direction (§18: gate can't move it)
 *                         FLIP          → Judge's direction (the gate already re-plan-verified)
 *                         STAND_ASIDE   → nothing — the gate invalidated the signal.
 *                       If the Judge never reports (LLM down/timeout), a deferred check fires
 *                       after JUDGE_WAIT_MS and proceeds deterministically — §18's "LLM down =
 *                       trades without narrative", DEFER-by-absence. Never zero trades.
 *
 * GATES applied in order before any position exists (each records why it refused):
 *   1. signal still ACTIVE and not past its TTL (§36 — expiry enforced at consumption too)
 *   2. agent active, lifecycle not BLOCKED / COOLDOWN (§37)
 *   3. capacity: openPositionCount < maxConcurrentPositions (§37 — audit: never checked)
 *   4. dailyLossLimit (§37 circuit breaker — audit: evaluator never called): tripping BLOCKs
 *      the agent to the next UTC day and refuses entry
 *   5. planner (§35): sizing/leverage/R:R/maxCorrelatedExposure — heldPositions are finally
 *      passed (audit: the gate "passed trivially"), balance is the portfolio's real cash
 *      (audit: judge-tier hardcoded 10_000)
 *   6. NO_TRADE → recordNoTrade on the signal (§19); TRADE → createPrediction (atomic
 *      ACTIVE→CONSUMED) → MARKET open at the §20 flat-bps fill / LIMIT pending at entry.
 *
 * The portfolio is get-or-created here for agents that predate portfolio-on-create
 * (`createTradingAgent` now creates one — same audit finding).
 */
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { judgeDecision, paperPortfolio, paperPosition, prediction, scoringConfig, signal, tradingAgent } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES, PRIORITY, QUEUE_NAMES, type EventBus } from '@tip/events';
import { AsOfMarketData } from '@tip/evaluation';
import { planTrade, type HeldPosition } from '@tip/planner';
import { createPrediction, recordNoTrade, type NoTradeReason } from '@tip/predictions';
import {
  createPortfolio, evaluateDailyLoss, openPosition, openPendingPosition, openPositionCount,
  perpFillPrice, DEFAULT_PERP_SLIPPAGE_BPS,
} from '@tip/paper-engine';
import { blockAgent, getAgentState, refreshAgentState, type ScoringConfig, type TradingStyle } from '@tip/trading-agents';

interface SignalCreatedPayload {
  signalId: string; tradingAgentId: string; symbol: string; domain: 'perp' | 'memecoin';
  direction: string; compositeScore: number; confidence: number; configVersion: number; expiresAt: string;
}
interface JudgeCompletedPayload { signalId: string; judgeDirection: string }

export interface EntryOrchestratorDeps {
  db: Db;
  bus: EventBus;
  /** Whether the Judge tier is registered — decides wait-for-gate vs immediate deterministic. */
  judgeEnabled: boolean;
  /** How long to wait for the Judge before the §18 DEFER-by-absence fallback. */
  judgeWaitMs?: number;
  /** Default paper balance when an agent has no portfolio yet and no configured one (§8). */
  defaultStartingCash?: number;
  log?: (msg: string, meta?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

const JUDGE_WAIT_MS = 90_000;
const DEFAULT_STARTING_CASH = 10_000;

export function createEntryOrchestrator(deps: EntryOrchestratorDeps): (event: DomainEvent) => Promise<void> {
  const log = deps.log ?? (() => {});
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

  /** Get-or-create the agent's paper portfolio (§14 — every TradingAgent owns one). */
  async function portfolioFor(agentId: string, cfg: ScoringConfig): Promise<{ id: string; cash: number }> {
    const existing = (await deps.db.select({ id: paperPortfolio.id, cash: paperPortfolio.cash })
      .from(paperPortfolio).where(eq(paperPortfolio.tradingAgentId, agentId)).limit(1))[0];
    if (existing) return { id: existing.id, cash: Number(existing.cash) };
    const startingCash = (cfg as { startingBalance?: number }).startingBalance
      ?? deps.defaultStartingCash ?? DEFAULT_STARTING_CASH;
    const p = await createPortfolio(deps.db, { tradingAgentId: agentId, startingCash });
    log('portfolio created', { agentId, startingCash });
    return { id: p.id, cash: startingCash };
  }

  /** The full gated path from a consumable signal to a prediction + paper position. */
  async function proceed(signalId: string, directionOverride: string | null): Promise<void> {
    const now = new Date();
    const sig = (await deps.db.select().from(signal).where(eq(signal.id, signalId)).limit(1))[0];
    if (!sig || sig.state !== 'ACTIVE') return; // consumed/invalidated/expired elsewhere — done
    if (sig.expiresAt <= now) {
      // §36 TTL enforced at consumption: a stale signal is expired, never traded.
      await deps.db.update(signal).set({ state: 'EXPIRED' })
        .where(and(eq(signal.id, signalId), eq(signal.state, 'ACTIVE')));
      return;
    }
    if (sig.domain !== 'perp') return; // memecoin entries land with the memecoin tier

    const agent = (await deps.db.select().from(tradingAgent).where(eq(tradingAgent.id, sig.tradingAgentId)).limit(1))[0];
    if (!agent || agent.status !== 'active') return;
    const lifecycle = await getAgentState(deps.db, agent.id);
    if (lifecycle && (lifecycle.state === 'BLOCKED' || lifecycle.state === 'COOLDOWN')) {
      log('entry refused: lifecycle', { signalId, state: lifecycle.state });
      return; // signal stays ACTIVE until TTL — §37
    }
    const cfgRow = (await deps.db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, agent.id), eq(scoringConfig.active, true))).limit(1))[0];
    if (!cfgRow) return;
    const cfg = cfgRow.config as ScoringConfig;

    const portfolio = await portfolioFor(agent.id, cfg);

    // §37 capacity — OPEN + PENDING_ENTRY count against maxConcurrentPositions.
    const open = await openPositionCount(deps.db, portfolio.id);
    if (open >= (cfg.maxConcurrentPositions ?? 1)) {
      log('entry refused: capacity', { signalId, open });
      return;
    }

    // §37 dailyLossLimit circuit breaker.
    const daily = await evaluateDailyLoss(deps.db, {
      tradingAgentId: agent.id,
      ...(cfg.dailyLossLimit !== undefined ? { dailyLossLimit: cfg.dailyLossLimit } : {}),
      now,
    });
    if (daily.tripped) {
      await blockAgent(deps.db, agent.id, daily.blockUntil);
      log('entry refused: daily loss limit — agent BLOCKED', { signalId, until: daily.blockUntil });
      return;
    }

    // Held positions for the §37 maxCorrelatedExposure gate (audit: never passed before).
    const heldRows = await deps.db.select({
      symbol: paperPosition.symbol, size: paperPosition.remainingSize, entry: paperPosition.entryPrice,
    })
      .from(paperPosition)
      .where(and(
        eq(paperPosition.portfolioId, portfolio.id),
        inArray(paperPosition.state, ['OPEN', 'PENDING_ENTRY']),
        eq(paperPosition.isShadow, false),
      ));
    const heldPositions: HeldPosition[] = heldRows.map((h) => ({
      symbol: h.symbol, notional: Number(h.size) * Number(h.entry),
    }));

    const direction = directionOverride ?? sig.direction;
    const view = new AsOfMarketData(deps.db, now);
    const plan = await planTrade(
      { symbol: sig.symbol, domain: 'perp', direction: direction as never },
      {
        style: agent.tradingStyle as TradingStyle, config: cfg, configVersion: cfgRow.version,
        balance: portfolio.cash, view, heldPositions,
      },
    );
    if (plan.kind === 'NO_TRADE') {
      await recordNoTrade(deps.db, { signalId, reason: plan.reason as NoTradeReason, detail: plan.detail });
      log('NO_TRADE', { signalId, reason: plan.reason });
      return;
    }

    // Prediction — atomic ACTIVE→CONSUMED; a concurrent consumer loses on the dup guard.
    const contributions = ((sig.evidence as { contributions?: { agent: string; agentVersion: number; weight: number; contribution: number }[] })
      ?.contributions ?? []);
    const predRes = await createPrediction(deps.db, {
      signalId, tradingAgentId: agent.id, setup: plan.setup,
      signalScore: Number(sig.compositeScore), confidence: Number(sig.confidence),
      direction,
      features: contributions.map((c) => ({
        agent: c.agent, agentVersion: c.agentVersion, weight: c.weight, contribution: c.contribution,
        score: c.weight !== 0 ? c.contribution / c.weight : 0,
      })),
    });
    if (!predRes.created) {
      log('prediction not created', { signalId, reason: predRes.reason });
      return;
    }
    const predictionId = predRes.prediction.id;
    await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
      type: EVENT_NAMES.PREDICTION_CREATED,
      eventTime: now.toISOString(), source: 'entry-orchestrator',
      payload: { predictionId, signalId, tradingAgentId: agent.id, symbol: sig.symbol, direction, entryType: plan.setup.entryType },
    });

    // Paper open (§20). MARKET fills at flat bps immediately; LIMIT parks a pending entry that
    // the tick monitor activates or expires.
    const clocksNow = new Date();
    if (plan.setup.entryType === 'LIMIT') {
      const pos = await openPendingPosition(deps.db, {
        portfolioId: portfolio.id, predictionId, symbol: sig.symbol, domain: 'perp',
        direction: plan.setup.direction, entryPrice: plan.setup.entry, size: plan.setup.positionSize,
        currentStop: plan.setup.stopLoss, takeProfit: plan.setup.takeProfit, ladder: null,
        openedAtEvent: clocksNow, openedAtProcessing: clocksNow,
      });
      log('pending LIMIT opened', { positionId: pos.id, entry: plan.setup.entry });
    } else {
      const fillPrice = perpFillPrice({
        last: plan.setup.entry, direction: plan.setup.direction, slippageBps: DEFAULT_PERP_SLIPPAGE_BPS,
      });
      const pos = await openPosition(deps.db, {
        portfolioId: portfolio.id, predictionId, symbol: sig.symbol, domain: 'perp',
        direction: plan.setup.direction, entryPrice: fillPrice, size: plan.setup.positionSize,
        currentStop: plan.setup.stopLoss, takeProfit: plan.setup.takeProfit, ladder: null,
        openedAtEvent: clocksNow, openedAtProcessing: clocksNow,
      });
      await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
        type: EVENT_NAMES.PAPER_TRADE_OPENED,
        eventTime: clocksNow.toISOString(), source: 'entry-orchestrator',
        payload: { positionId: pos.id, predictionId, symbol: sig.symbol, direction: plan.setup.direction, price: fillPrice, size: plan.setup.positionSize },
      }, { priority: PRIORITY.FAST }); // §11 reaction lane — the fill IS the reaction path
      log('position opened', { positionId: pos.id, price: fillPrice });
    }
    await refreshAgentState(deps.db, agent.id, clocksNow); // → IN_TRADE / PENDING_ENTRY (§37)
  }

  /** Direction resolution once the gate has spoken (or never will). */
  async function proceedFromJudge(signalId: string): Promise<void> {
    const jd = (await deps.db.select().from(judgeDecision)
      .where(eq(judgeDecision.signalId, signalId)).limit(1))[0];
    if (!jd) { await proceed(signalId, null); return; } // no decision recorded — deterministic
    if (jd.judgeAction === 'STAND_ASIDE') return; // gate invalidated the signal, no real trade
    if (jd.judgeAction === 'FLIP' && !jd.flipRefusedByPlanner) {
      await proceed(signalId, jd.judgeDirection);
      return;
    }
    await proceed(signalId, null); // AGREE / DEFER / refused FLIP → deterministic
  }

  return async (event: DomainEvent): Promise<void> => {
    if (event.type === EVENT_NAMES.SIGNAL_CREATED) {
      const p = event.payload as SignalCreatedPayload;
      if (!p?.signalId || p.domain !== 'perp') return;
      if (!deps.judgeEnabled) {
        await proceed(p.signalId, null);
        return;
      }
      // Judge enabled: the gate acts on judge.evaluation.completed. Arm the §18
      // DEFER-by-absence fallback for the LLM-down case.
      setTimer(() => {
        void (async () => {
          const existing = (await deps.db.select({ id: prediction.id }).from(prediction)
            .where(eq(prediction.signalId, p.signalId)).limit(1))[0];
          if (existing) return; // gate path already handled it
          await proceedFromJudge(p.signalId);
        })().catch((e) => log('judge-wait fallback failed', { signalId: p.signalId, err: String(e) }));
      }, deps.judgeWaitMs ?? JUDGE_WAIT_MS);
      return;
    }

    if (event.type === EVENT_NAMES.JUDGE_EVALUATION_COMPLETED) {
      const p = event.payload as JudgeCompletedPayload;
      if (!p?.signalId) return;
      // The gate handler ran before us in the same dispatcher pass — judge_decision is written.
      await proceedFromJudge(p.signalId);
    }
  };
}

/**
 * §36 TTL sweep — transitions every ACTIVE signal past its TTL to EXPIRED (audit-2: nothing
 * ever performed this transition; signals accumulated ACTIVE forever). Cheap bulk update,
 * scheduled from main.ts alongside the lifecycle sweep.
 */
export async function expireStaleSignals(db: Db, now = new Date()): Promise<number> {
  const rows = await db.update(signal).set({ state: 'EXPIRED' })
    .where(and(eq(signal.state, 'ACTIVE'), lt(signal.expiresAt, now)))
    .returning({ id: signal.id });
  return rows.length;
}
