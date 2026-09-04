/**
 * Dynamic watchlist derivation. Instead of a hardcoded symbol list, ingestion adapters ask this
 * for the set of things that CURRENTLY have consumers — the union of `universe` across active,
 * non-blocked TradingAgents in each domain. Empty set = don't run the adapter at all
 * (no active agent means the bandwidth + DB writes serve nothing).
 *
 * The truth lives in `trading_agent` — no separate config table, no drift. Called on worker
 * startup and again on every `trading_agent.upserted` event (§10 build-time addition).
 */
import { and, eq, ne } from 'drizzle-orm';
import { tradingAgent, type Db } from '@tip/database';

export interface Watchlist {
  /** Distinct perp symbols to subscribe on Bybit (empty = don't start the adapter). */
  readonly perp: readonly string[];
  /** True if any memecoin agent is active — gates Helius adapter registration. */
  readonly memecoinActive: boolean;
}

/**
 * Read the current watchlist from the database. `status='active'` filters out paused/archived
 * agents; `lifecycleState != 'BLOCKED'` filters out agents currently gated by feed staleness
 * (§37) — their subscription is a waste until they unblock (they'll be re-included on the next
 * upsert event when the block clears).
 *
 * NOTE: BLOCKED agents flip-flop transiently. For MVP we include them anyway so a stale-feed
 * blip doesn't tear down and rebuild the whole subscription set. Revisit if unblock churn
 * becomes a problem.
 */
export async function deriveWatchlist(db: Db): Promise<Watchlist> {
  const rows = await db
    .select({ domain: tradingAgent.domain, universe: tradingAgent.universe })
    .from(tradingAgent)
    .where(and(eq(tradingAgent.status, 'active'), ne(tradingAgent.lifecycleState, 'ARCHIVED')));

  const perp = new Set<string>();
  let memecoinActive = false;
  for (const r of rows) {
    if (r.domain === 'perp') {
      for (const s of r.universe ?? []) if (s) perp.add(s);
    } else if (r.domain === 'memecoin') {
      memecoinActive = true;
    }
  }
  return { perp: [...perp].sort(), memecoinActive };
}

/**
 * Diff two watchlists — used by adapters to compute the minimal subscribe/unsubscribe delta
 * instead of tearing down and rebuilding the whole connection on every change.
 */
export interface WatchlistDelta {
  readonly perpAdded: readonly string[];
  readonly perpRemoved: readonly string[];
  readonly memecoinChanged: boolean;
}

export function diffWatchlist(prev: Watchlist, next: Watchlist): WatchlistDelta {
  const prevSet = new Set(prev.perp);
  const nextSet = new Set(next.perp);
  return {
    perpAdded: [...nextSet].filter((s) => !prevSet.has(s)).sort(),
    perpRemoved: [...prevSet].filter((s) => !nextSet.has(s)).sort(),
    memecoinChanged: prev.memecoinActive !== next.memecoinActive,
  };
}
