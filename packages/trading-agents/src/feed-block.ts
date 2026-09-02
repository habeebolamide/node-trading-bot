/**
 * Feed-staleness → BLOCKED bridge (§10 / §37). "The specific bug that killed the previous bot"
 * (plan's words): a feed dies silently, downstream keeps resolving against frozen data. §37 says
 * a stale feed moves DEPENDENT TradingAgents to BLOCKED; recovery clears them.
 *
 * The FeedMonitor lives in @tip/ingestion and must not depend on @tip/trading-agents (dependency
 * direction). So this bridge lives here, and the worker wires the FeedMonitor's onStale/onRecover
 * callbacks to it. "Dependent" = a non-archived agent whose universe includes the stale feed's
 * symbol; a symbol-less/global feed (e.g. the shared tickers stream) blocks every perp agent.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { tradingAgent, type Db } from '@tip/database';
import { blockAgent, refreshAgentState } from './agent-lifecycle.js';

/**
 * Parse a symbol out of a feed id. Null = global feed. Registered feed ids today are all
 * symbol-less (bybit.kline.<tf>, bybit.tickers, bybit.liquidation, bybit.positioning_poll,
 * helius.wallet_webhook, helius.rest) — so a stale kline stream blocks EVERY perp agent, which
 * is the conservative choice (audit-2 #7: the old parser looked for a `SYMBOL` token that never
 * appears in the actual feed ids, so every match was null anyway; now that's the explicit
 * default rather than a bug). A per-symbol variant lands together with per-symbol feed ids.
 */
export function symbolForFeed(feedId: string): string | null {
  const parts = feedId.split('.');
  const candidate = parts.find((p) => /^[A-Z0-9]{2,}USDT?$/.test(p));
  return candidate ?? null;
}

/**
 * Block every agent that depends on a now-stale feed. A symbol-scoped feed blocks agents whose
 * `universe` array contains that symbol; a global feed blocks all perp agents. Feed-staleness
 * BLOCKED is INDEFINITE (`until = null`) — cleared by recovery, not a timer.
 */
export async function blockAgentsForStaleFeed(db: Db, feedId: string): Promise<string[]> {
  const symbol = symbolForFeed(feedId);
  const rows = symbol
    ? await db.select({ id: tradingAgent.id }).from(tradingAgent)
        .where(and(ne(tradingAgent.status, 'archived'), sql`${symbol} = ANY(${tradingAgent.universe})`))
    : await db.select({ id: tradingAgent.id }).from(tradingAgent)
        .where(and(ne(tradingAgent.status, 'archived'), eq(tradingAgent.domain, 'perp')));
  for (const r of rows) await blockAgent(db, r.id, null);
  return rows.map((r) => r.id);
}

/**
 * Clear BLOCKED on the agents that depend on a recovered feed. Only clears agents currently in
 * BLOCKED with a null timer (feed-staleness blocks), so a daily-loss BLOCKED (which has a timer)
 * is left alone — a recovered feed must not lift a risk breaker.
 */
export async function unblockAgentsForRecoveredFeed(db: Db, feedId: string): Promise<string[]> {
  const symbol = symbolForFeed(feedId);
  const rows = symbol
    ? await db.select({ id: tradingAgent.id }).from(tradingAgent)
        .where(and(eq(tradingAgent.lifecycleState, 'BLOCKED'), sql`${tradingAgent.lifecycleUntil} is null`,
                   sql`${symbol} = ANY(${tradingAgent.universe})`))
    : await db.select({ id: tradingAgent.id }).from(tradingAgent)
        .where(and(eq(tradingAgent.lifecycleState, 'BLOCKED'), sql`${tradingAgent.lifecycleUntil} is null`,
                   eq(tradingAgent.domain, 'perp')));
  for (const r of rows) {
    await db.update(tradingAgent).set({ lifecycleState: 'IDLE', lifecycleUntil: null }).where(eq(tradingAgent.id, r.id));
    await refreshAgentState(db, r.id);
  }
  return rows.map((r) => r.id);
}
