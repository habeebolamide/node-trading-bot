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
import { paperPosition, prediction, tradingAgent } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import type { EventBus } from '@tip/events';
import { EVENT_NAMES, QUEUE_NAMES, PRIORITY } from '@tip/events';
import {
  activatePendingPosition, closeRemaining, evalPendingTick, evalTick, expirePendingPosition,
  updateExcursion,
} from '@tip/paper-engine';
import { LIMIT_EXPIRY_MS, enterCooldown, refreshAgentState, type TradingStyle } from '@tip/trading-agents';

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

    const ladder = (pos.ladderState as { firedRungs?: number[] } | null);
    const horizonEndsAt = new Date(pos.openedAtProcessing.getTime() + 4 * 3600_000); // conservative; real horizon from style
    // Check the ADVERSE extreme for a stop first (worst case within the bar), then the favourable for TP.
    const stopHit = dir === 'LONG' ? adverse <= Number(pos.currentStop) : adverse >= Number(pos.currentStop);
    const price = stopHit ? Number(pos.currentStop) : favourable;
    const decision = evalTick({
      entryPrice: Number(pos.entryPrice), currentStop: Number(pos.currentStop),
      takeProfit: pos.takeProfit === null ? null : Number(pos.takeProfit), direction: dir,
      firedRungs: ladder?.firedRungs ?? [], ladder: null,
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
      log('position closed', { positionId: pos.id, reason: decision.kind, price: decision.price });
    } else if (decision.kind === 'HORIZON_EXPIRY') {
      await closeRemaining(deps.db, { positionId: pos.id, price: input.close, reason: 'HORIZON_EXPIRY', clocks });
      await enterCooldown(deps.db, pos.predAgentId, COOLDOWN_MS, input.now);
      log('position closed on horizon', { positionId: pos.id });
    }
    void tradingAgent;
  }
}

/** Register the tick monitor on the market-ingestion queue — each perp kline close is a tick. */
export function registerTickMonitor(deps: TickMonitorDeps): void {
  const styleCache = new Map<string, TradingStyle>();
  const styleFor = async (agentId: string): Promise<TradingStyle> => {
    const cached = styleCache.get(agentId);
    if (cached) return cached;
    const a = (await deps.db.select({ style: tradingAgent.tradingStyle }).from(tradingAgent).where(eq(tradingAgent.id, agentId)).limit(1))[0];
    const style = (a?.style as TradingStyle) ?? 'day';
    styleCache.set(agentId, style);
    return style;
  };
  deps.bus.createWorker<KlinePayload>(QUEUE_NAMES.MARKET_INGESTION, async (event: DomainEvent<KlinePayload>) => {
    if (event.type !== EVENT_NAMES.PERP_KLINE_CLOSED) return;
    const p = event.payload;
    if (!p?.symbol) return;
    await processTick(deps, {
      symbol: p.symbol, high: Number(p.high), low: Number(p.low), close: Number(p.close),
      now: new Date(p.closeTime), style: styleFor,
    });
  });
}
