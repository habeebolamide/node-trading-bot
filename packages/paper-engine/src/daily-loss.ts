/**
 * Daily-loss circuit breaker (§37 portfolio-level risk). Sums the agent's realized P&L for the
 * current UTC trading day across its paper portfolio; if the cumulative loss crosses
 * `dailyLossLimit`, the agent is BLOCKED for the remainder of that day — independent of and in
 * addition to the per-trade risk gates (§35).
 *
 * `dailyLossLimit` is a ScoringConfig field, expressed as a FRACTION of starting cash (e.g. 0.05
 * = block after a 5% day). Absent/zero → no breaker.
 *
 * The breaker reads `paper_position_fill` rows dated today and sums realized P&L on CLOSED
 * positions. It's a read + a conditional transition, so it's cheap to call after every close.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import { paperPortfolio, paperPosition, prediction, type Db } from '@tip/database';

/** Start of the current UTC day for `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** End of the current UTC day (exclusive) — the BLOCKED `until` for a daily-loss trip. */
export function utcDayEnd(now: Date): Date {
  const d = utcDayStart(now);
  return new Date(d.getTime() + 24 * 60 * 60 * 1000);
}

export interface DailyLossResult {
  readonly tripped: boolean;
  readonly realizedTodayPct: number;   // negative = a loss
  readonly limitPct: number | null;
  readonly blockUntil: Date | null;
}

/**
 * Evaluate the breaker for one agent as of `now`. Returns whether it tripped + the numbers.
 * Does NOT itself transition the agent — the caller wires `blockAgent(db, agentId, blockUntil)`
 * so the paper engine stays free of a dependency on @tip/trading-agents.
 */
export async function evaluateDailyLoss(
  db: Db,
  input: { tradingAgentId: string; dailyLossLimit?: number; now: Date },
): Promise<DailyLossResult> {
  const limit = input.dailyLossLimit;
  if (!limit || limit <= 0) return { tripped: false, realizedTodayPct: 0, limitPct: null, blockUntil: null };

  const dayStart = utcDayStart(input.now);

  // The agent's portfolios (one in practice, but sum defensively).
  const ports = await db.select({ id: paperPortfolio.id, startingCash: paperPortfolio.startingCash })
    .from(paperPortfolio).where(eq(paperPortfolio.tradingAgentId, input.tradingAgentId));
  if (ports.length === 0) return { tripped: false, realizedTodayPct: 0, limitPct: limit, blockUntil: null };
  const startingCash = ports.reduce((s, p) => s + Number(p.startingCash), 0);
  if (startingCash <= 0) return { tripped: false, realizedTodayPct: 0, limitPct: limit, blockUntil: null };

  // Realized P&L on positions this agent closed today. Uses closed_at ≥ day start.
  const closed = await db.select({ pnl: paperPosition.realizedPnl, closedAt: paperPosition.closedAt })
    .from(paperPosition)
    .innerJoin(prediction, eq(prediction.id, paperPosition.predictionId))
    .where(and(
      eq(prediction.tradingAgentId, input.tradingAgentId),
      eq(paperPosition.state, 'CLOSED'),
      gte(paperPosition.closedAt, dayStart),
    ));
  const realizedToday = closed.reduce((s, c) => s + Number(c.pnl), 0);
  const realizedTodayPct = realizedToday / startingCash;

  // Trip when the day's LOSS (a negative return) is at or beyond the configured fraction.
  const tripped = realizedTodayPct <= -Math.abs(limit);
  return {
    tripped,
    realizedTodayPct,
    limitPct: limit,
    blockUntil: tripped ? utcDayEnd(input.now) : null,
  };
}

/** Helper kept exported for tests. */
export const _testing = { inArray };
