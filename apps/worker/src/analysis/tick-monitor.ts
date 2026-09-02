/**
 * Tick monitor (§10, §20 — audit #2). The §10 "separate lightweight consumer that never runs
 * the full pipeline." Watches open + pending paper positions against a price feed and drives the
 * m6 `evalTick` / `evalPendingTick` decisions:
 *
 *   OPEN position          → STOP_LOSS / TAKE_PROFIT / LADDER_RUNG / HORIZON on crossing.
 *   PENDING_ENTRY position → ACTIVATE_LIMIT on limit fill, EXPIRE_LIMIT past the window.
 *
 * For perp, the price feed is the kline stream — each closed candle is a "tick" at its close
 * (and its high/low bound the intrabar range for stop/target crossing). This is honest about
 * granularity: between closes the price is unobserved, exactly as memecoin treats each swap as
 * a tick. A true sub-second tick feed is a later refinement; the decision logic is identical.
 *
 * On a full close it transitions the owning agent IN_TRADE → COOLDOWN (§37).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { paperPosition, prediction, scoringConfig, tradingAgent } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import type { EventBus } from '@tip/events';
import { EVENT_NAMES, QUEUE_NAMES, PRIORITY } from '@tip/events';
import {
  activatePendingPosition, applyLadderRung, closeRemaining, crossedLadderRungs, evalPendingTick,
  evalTick, expirePendingPosition, updateExcursion, evaluateDailyLoss,
  type LadderRungConfig,
} from '@tip/paper-engine';
import { HORIZON_MS } from '@tip/planner';
import { blockAgent, LIMIT_EXPIRY_MS, enterCooldown, refreshAgentState, type TradingStyle } from '@tip/trading-agents';

const COOLDOWN_MS = 5 * 60_000; // 5m pause after a close before returning to IDLE (§37)

interface KlinePayload {
  symbol: string; timeframe: string;
  closeTime: string | Date; open: string; high: string; low: string; close: string;
}

export interface TickMonitorDeps {
  db: Db;
  bus: EventBus;
  log?: (msg: string, meta?: unknown) => void;
}



/** The agent's configured profit ladder (Part II §10), cached per agent for the tick path. */
const ladderCache = new Map<string, readonly LadderRungConfig[] | null>();
async function ladderFor(deps: TickMonitorDeps, agentId: string): Promise<readonly LadderRungConfig[] | null> {
  if (ladderCache.has(agentId)) return ladderCache.get(agentId)!;
  const cfgRow = (await deps.db.select({ config: scoringConfig.config })
    .from(scoringConfig)
    .where(and(eq(scoringConfig.tradingAgentId, agentId), eq(scoringConfig.active, true)))
    .limit(1))[0];
  const ladder = ((cfgRow?.config as { profitLadder?: LadderRungConfig[] } | undefined)?.profitLadder) ?? null;
  ladderCache.set(agentId, ladder);
  return ladder;
}

/**
 * §37 dailyLossLimit — trip check AFTER a close books P&L (audit-2: the evaluator existed but
 * nothing called it; the breaker must fire on the losing close, not wait for the next entry).
 */
async function tripDailyLossIfCrossed(deps: TickMonitorDeps, agentId: string, now: Date): Promise<void> {
  const cfgRow = (await deps.db.select({ config: scoringConfig.config })
    .from(scoringConfig)
    .where(and(eq(scoringConfig.tradingAgentId, agentId), eq(scoringConfig.active, true)))
    .limit(1))[0];
  const limit = (cfgRow?.config as { dailyLossLimit?: number } | undefined)?.dailyLossLimit;
  if (!limit) return;
  const daily = await evaluateDailyLoss(deps.db, { tradingAgentId: agentId, dailyLossLimit: limit, now });
  if (daily.tripped) {
    await blockAgent(deps.db, agentId, daily.blockUntil);
    (deps.log ?? (() => {}))('daily loss limit tripped — agent BLOCKED', { agentId, until: daily.blockUntil });
  }
}

/**
 * Evaluate every non-shadow OPEN/PENDING position on `symbol` against a price observation
 * `{ high, low, close }`. Called per kline close.
 */
export async function processTick(deps: TickMonitorDeps, input: {
  symbol: string; high: number; low: number; close: number; now: Date; style: (agentId: string) => Promise<TradingStyle>;
}): Promise<void> {
  const log = deps.log ?? (() => {});
  const positions = await deps.db.select({
    id: paperPosition.id, predictionId: paperPosition.predictionId, direction: paperPosition.direction,
    domain: paperPosition.domain,
    state: paperPosition.state, entryPrice: paperPosition.entryPrice, currentStop: paperPosition.currentStop,
    takeProfit: paperPosition.takeProfit, ladderState: paperPosition.ladderState,
    openedAtProcessing: paperPosition.openedAtProcessing,
    predAgentId: prediction.tradingAgentId, horizon: prediction.horizon,
  })
    .from(paperPosition)
    .innerJoin(prediction, eq(prediction.id, paperPosition.predictionId))
    .where(and(
      eq(paperPosition.symbol, input.symbol),
      inArray(paperPosition.state, ['OPEN', 'PENDING_ENTRY']),
      eq(paperPosition.isShadow, false),
    ));

  for (const pos of positions) {
    const dir = pos.direction as 'LONG' | 'SHORT';
    const clocks = { fillAtEvent: input.now, fillAtProcessing: input.now };

    if (pos.state === 'PENDING_ENTRY') {
      const style = await input.style(pos.predAgentId);
      const expiresAt = new Date(pos.openedAtProcessing.getTime() + LIMIT_EXPIRY_MS[style]);
      // Check both the intrabar extremes for a fill (a LONG limit below fills if low ≤ limit).
      const crossingPrice = dir === 'LONG' ? input.low : input.high;
      const decision = evalPendingTick({ direction: dir, limitPrice: Number(pos.entryPrice), price: crossingPrice, now: input.now, expiresAt });
      if (decision.kind === 'ACTIVATE_LIMIT') {
        await activatePendingPosition(deps.db, { positionId: pos.id, fillPrice: decision.fillPrice, clocks });
        await refreshAgentState(deps.db, pos.predAgentId, input.now); // → IN_TRADE
        log('limit filled', { positionId: pos.id, price: decision.fillPrice });
      } else if (decision.kind === 'EXPIRE_LIMIT') {
        await expirePendingPosition(deps.db, pos.id, input.now);
        await refreshAgentState(deps.db, pos.predAgentId, input.now); // → IDLE/WATCHING
        log('limit expired', { positionId: pos.id });
      }
      continue;
    }

    // OPEN — update excursion, then evaluate exits against the intrabar extremes.
    const adverse = dir === 'LONG' ? input.low : input.high;
    const favourable = dir === 'LONG' ? input.high : input.low;
    await updateExcursion(deps.db, pos.id, favourable);
    await updateExcursion(deps.db, pos.id, adverse);

    const ladderState = (pos.ladderState as { firedRungs?: number[] } | null);
    // Real planning horizon from the prediction (audit-2 #4: was hardcoded +4h — a swing
    // position with a 3d horizon was force-closed after 4 hours).
    const horizonMs = HORIZON_MS[pos.horizon as keyof typeof HORIZON_MS] ?? 4 * 3600_000;
    const horizonEndsAt = new Date(pos.openedAtProcessing.getTime() + horizonMs);
    // Real configured ladder (audit-2 #4: was hardcoded null — LADDER_RUNG could never fire).
    // Memecoin-only by Part II §10; perp uses single-level TP (config validation enforces it).
    const ladder = pos.domain === 'memecoin' ? await ladderFor(deps, pos.predAgentId) : null;

    // Ladder rungs first: a favourable gap can cross several rungs in one bar — fire each in
    // order at its own crossing price (Part II §10 gap-up tie-break), then re-evaluate exits.
    if (ladder && ladder.length > 0 && dir === 'LONG') {
      const rungIdxs = crossedLadderRungs(Number(pos.entryPrice), favourable, ladder, ladderState?.firedRungs ?? []);
      for (const idx of rungIdxs) {
        // Gap-up tie-break (Part II §10): each rung fills at ITS OWN crossing price, not the bar's final.
        const rungPrice = Number(pos.entryPrice) * ladder[idx]!.at;
        await applyLadderRung(deps.db, {
          positionId: pos.id, rungIndex: idx, rungPrice, rung: ladder[idx]!, clocks,
        });
        log('ladder rung fired', { positionId: pos.id, rung: idx, price: rungPrice });
      }
    }

    // Check the ADVERSE extreme for a stop first (worst case within the bar), then the favourable for TP.
    const stopHit = dir === 'LONG' ? adverse <= Number(pos.currentStop) : adverse >= Number(pos.currentStop);
    const price = stopHit ? Number(pos.currentStop) : favourable;
    const decision = evalTick({
      entryPrice: Number(pos.entryPrice), currentStop: Number(pos.currentStop),
      takeProfit: pos.takeProfit === null ? null : Number(pos.takeProfit), direction: dir,
      firedRungs: (ladderState?.firedRungs ?? []),
      ladder: ladder && ladder.length > 0 ? ladder : null,
      price, now: input.now, horizonEndsAt, walletExitReached: false,
    });

    if (decision.kind === 'STOP_LOSS' || decision.kind === 'TAKE_PROFIT') {
      await closeRemaining(deps.db, { positionId: pos.id, price: decision.price, reason: decision.kind, clocks });
      await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
        type: decision.kind === 'STOP_LOSS' ? EVENT_NAMES.PAPER_TRADE_SL_HIT : EVENT_NAMES.PAPER_TRADE_TP_HIT,
        eventTime: input.now.toISOString(), source: 'tick-monitor',
        payload: { positionId: pos.id, price: decision.price },
      }, { priority: PRIORITY.FAST }); // §11 reaction lane — a fill must not queue behind analysis
      await enterCooldown(deps.db, pos.predAgentId, COOLDOWN_MS, input.now); // IN_TRADE → COOLDOWN
      await tripDailyLossIfCrossed(deps, pos.predAgentId, input.now);
      log('position closed', { positionId: pos.id, reason: decision.kind, price: decision.price });
    } else if (decision.kind === 'HORIZON_EXPIRY') {
      await closeRemaining(deps.db, { positionId: pos.id, price: input.close, reason: 'HORIZON_EXPIRY', clocks });
      await enterCooldown(deps.db, pos.predAgentId, COOLDOWN_MS, input.now);
      await tripDailyLossIfCrossed(deps, pos.predAgentId, input.now);
      log('position closed on horizon', { positionId: pos.id });
    }
    void tradingAgent;
  }
}

/**
 * Build the tick-monitor's event handler WITHOUT registering a queue worker. Two BullMQ workers
 * on the same queue COMPETE for jobs (each job is delivered to exactly one), so every consumer
 * of the market queue must share ONE worker — main.ts owns that dispatcher and calls this
 * handler alongside the analysis tier's (audit #11 dispatcher fix).
 */
export function createTickHandler(deps: TickMonitorDeps): (event: DomainEvent<KlinePayload>) => Promise<void> {
  const styleCache = new Map<string, TradingStyle>();
  const styleFor = async (agentId: string): Promise<TradingStyle> => {
    const cached = styleCache.get(agentId);
    if (cached) return cached;
    const a = (await deps.db.select({ style: tradingAgent.tradingStyle }).from(tradingAgent).where(eq(tradingAgent.id, agentId)).limit(1))[0];
    const style = (a?.style as TradingStyle) ?? 'day';
    styleCache.set(agentId, style);
    return style;
  };
  return async (event: DomainEvent<KlinePayload>): Promise<void> => {
    if (event.type !== EVENT_NAMES.PERP_KLINE_CLOSED) return;
    const p = event.payload;
    if (!p?.symbol) return;
    await processTick(deps, {
      symbol: p.symbol, high: Number(p.high), low: Number(p.low), close: Number(p.close),
      now: new Date(p.closeTime), style: styleFor,
    });
  };
}

/**
 * Register the tick monitor with its OWN queue worker. Only for processes where nothing else
 * consumes the market queue (tests) — in the main worker use `createTickHandler` through the
 * shared dispatcher instead, or klines get split between competing workers.
 */
export function registerTickMonitor(deps: TickMonitorDeps): void {
  deps.bus.createWorker<KlinePayload>(QUEUE_NAMES.MARKET_INGESTION, createTickHandler(deps));
}
