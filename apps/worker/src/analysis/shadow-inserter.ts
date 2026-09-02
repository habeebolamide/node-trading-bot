/**
 * Shadow-prediction inserter (§18 — audit-2 #12: the shadow machinery had no live writer).
 *
 * Both Judge disagreement outcomes emit an event pair here:
 *   signal.flipped     → REAL prediction (Judge direction) already exists via the entry
 *                        orchestrator. Insert a SHADOW for the DETERMINISTIC direction so §23
 *                        can measure "did the flip beat what we would have done?"
 *   signal.stood_aside → No real prediction (the gate invalidated the signal). Insert a
 *                        shadow for the DETERMINISTIC direction — the counterfactual "what
 *                        would we have won if we'd traded anyway?"
 *
 * The plan for the deterministic direction is (re-)computed here against an as-of view bound
 * to now — the same read the gate uses for the FLIP re-plan, kept honest by rules 21/22.
 * Also opens a SHADOW paper position so the tick monitor resolves it (isShadow filter has been
 * removed from the tick query alongside this change).
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { paperPortfolio, prediction, scoringConfig, signal, tradingAgent } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES, type EventBus } from '@tip/events';
import { AsOfMarketData } from '@tip/evaluation';
import { planTrade } from '@tip/planner';
import { insertFlipShadow, insertStandAsideShadow } from '@tip/predictions';
import { openPosition, perpFillPrice, DEFAULT_PERP_SLIPPAGE_BPS } from '@tip/paper-engine';
import type { Direction, ScoringConfig, TradingStyle } from '@tip/trading-agents';

interface FlippedPayload {
  signalId: string; judgeDirection: string; deterministicDirection: string; configVersion: number;
}
interface StoodAsidePayload {
  signalId: string; deterministicDirection: string; configVersion: number;
  signalScore: number; confidence: number;
}

export interface ShadowInserterDeps {
  db: Db; bus: EventBus;
  log?: (msg: string, meta?: unknown) => void;
}

export function createShadowInserter(deps: ShadowInserterDeps): (event: DomainEvent) => Promise<void> {
  const log = deps.log ?? (() => {});

  async function loadContext(signalId: string): Promise<{
    style: TradingStyle; cfg: ScoringConfig; configVersion: number; portfolioId: string;
    sigSymbol: string; sigDomain: 'perp' | 'memecoin'; agentId: string;
  } | null> {
    const sig = (await deps.db.select().from(signal).where(eq(signal.id, signalId)).limit(1))[0];
    if (!sig || sig.domain !== 'perp') return null;
    const a = (await deps.db.select().from(tradingAgent).where(eq(tradingAgent.id, sig.tradingAgentId)).limit(1))[0];
    if (!a) return null;
    const cfgRow = (await deps.db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, a.id), eq(scoringConfig.active, true))).limit(1))[0];
    if (!cfgRow) return null;
    const port = (await deps.db.select().from(paperPortfolio).where(eq(paperPortfolio.tradingAgentId, a.id)).limit(1))[0];
    if (!port) return null;
    return {
      style: a.tradingStyle as TradingStyle, cfg: cfgRow.config as ScoringConfig,
      configVersion: cfgRow.version, portfolioId: port.id,
      sigSymbol: sig.symbol, sigDomain: sig.domain as 'perp' | 'memecoin', agentId: a.id,
    };
  }

  async function openShadowPosition(portfolioId: string, symbol: string, direction: 'LONG' | 'SHORT',
    setup: { entry: number; stopLoss: number; takeProfit: number | null; positionSize: number }, predictionId: string): Promise<void> {
    const fillPrice = perpFillPrice({ last: setup.entry, direction, slippageBps: DEFAULT_PERP_SLIPPAGE_BPS });
    const now = new Date();
    await openPosition(deps.db, {
      portfolioId, predictionId, symbol, domain: 'perp', direction,
      entryPrice: fillPrice, size: setup.positionSize,
      currentStop: setup.stopLoss, takeProfit: setup.takeProfit, ladder: null,
      openedAtEvent: now, openedAtProcessing: now, isShadow: true,
    });
  }

  return async (event: DomainEvent): Promise<void> => {
    if (event.type === EVENT_NAMES.SIGNAL_FLIPPED) {
      const p = event.payload as FlippedPayload;
      const ctx = await loadContext(p.signalId);
      if (!ctx) return;
      // The REAL Judge-direction prediction was created by the entry orchestrator. Find it and
      // insert the shadow for the DETERMINISTIC direction (opposite of Judge here).
      const real = (await deps.db.select().from(prediction).where(eq(prediction.signalId, p.signalId)).limit(1))[0];
      if (!real) return;
      const view = new AsOfMarketData(deps.db, new Date());
      const plan = await planTrade(
        { symbol: ctx.sigSymbol, domain: 'perp', direction: p.deterministicDirection as never },
        { style: ctx.style, config: ctx.cfg, configVersion: ctx.configVersion, balance: 10_000, view },
      );
      if (plan.kind !== 'TRADE') return;
      const shadow = await insertFlipShadow(deps.db, {
        signalId: p.signalId, realPredictionId: real.id,
        deterministicDirection: p.deterministicDirection as Direction,
        plan: { kind: 'TRADE', ...plan.setup, horizon: plan.setup.horizon },
        configVersion: ctx.configVersion,
        signalScore: Number(real.score), confidence: Number(real.confidence),
      });
      if (shadow) {
        await openShadowPosition(ctx.portfolioId, ctx.sigSymbol, plan.setup.direction, plan.setup, shadow.id);
        log('flip shadow opened', { signalId: p.signalId, predictionId: shadow.id });
      }
      return;
    }
    if (event.type === EVENT_NAMES.SIGNAL_STOOD_ASIDE) {
      const p = event.payload as StoodAsidePayload;
      const ctx = await loadContext(p.signalId);
      if (!ctx) return;
      const view = new AsOfMarketData(deps.db, new Date());
      const plan = await planTrade(
        { symbol: ctx.sigSymbol, domain: 'perp', direction: p.deterministicDirection as never },
        { style: ctx.style, config: ctx.cfg, configVersion: ctx.configVersion, balance: 10_000, view },
      );
      if (plan.kind !== 'TRADE') return;
      const shadow = await insertStandAsideShadow(deps.db, {
        signalId: p.signalId,
        deterministicDirection: p.deterministicDirection as Direction,
        plan: { kind: 'TRADE', ...plan.setup, horizon: plan.setup.horizon },
        configVersion: p.configVersion,
        signalScore: p.signalScore, confidence: p.confidence,
      });
      if (shadow) {
        await openShadowPosition(ctx.portfolioId, ctx.sigSymbol, plan.setup.direction, plan.setup, shadow.id);
        log('stand-aside shadow opened', { signalId: p.signalId, predictionId: shadow.id });
      }
    }
  };
}
