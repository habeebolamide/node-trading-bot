/**
 * Trading Agent Lifecycle (§37). ONE state machine per TradingAgent (not per symbol — an agent
 * owns one shared paper portfolio across its universe, §14).
 *
 *   IDLE          → no active signal, no position. Baseline; running its triggers, waiting.
 *   WATCHING      → an ACTIVE signal exists but hasn't become a trade setup yet.
 *   PENDING_ENTRY → a LIMIT setup exists, entry not filled (Part III §4).
 *   IN_TRADE      → holding a position.
 *   COOLDOWN      → position just closed; pausing before returning to IDLE.
 *   BLOCKED       → external stop (daily loss limit, feed staleness, kill switch). Independent
 *                   of any single symbol; recoverable to IDLE.
 *
 * DERIVED vs STICKY. IDLE/WATCHING/PENDING_ENTRY/IN_TRADE are DERIVABLE from live signals +
 * positions — there's no truth to store, so we compute them. COOLDOWN and BLOCKED are STICKY
 * policy states that can't be derived (a cooldown is a timer; a block is an override), so they
 * are stored on `trading_agent.lifecycle_state` with an optional `lifecycle_until`. The derived
 * states are written too (so the dashboard reads one column), but the sticky ones WIN until they
 * clear.
 */
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { paperPosition, prediction, signal, tradingAgent, type Db } from '@tip/database';

export type AgentLifecycleState =
  | 'IDLE' | 'WATCHING' | 'PENDING_ENTRY' | 'IN_TRADE' | 'COOLDOWN' | 'BLOCKED';

const STICKY: ReadonlySet<AgentLifecycleState> = new Set(['COOLDOWN', 'BLOCKED']);

/**
 * Valid transitions (§37). BLOCKED is reachable from ANY state (external stop can fire anytime)
 * and clears to IDLE. COOLDOWN follows a close and clears to IDLE. The derived states flow
 * IDLE ↔ WATCHING ↔ PENDING_ENTRY ↔ IN_TRADE freely because they reflect observed reality, not
 * a policy the machine enforces.
 */
const ALLOWED: Record<AgentLifecycleState, ReadonlySet<AgentLifecycleState>> = {
  IDLE:          new Set(['WATCHING', 'PENDING_ENTRY', 'IN_TRADE', 'BLOCKED']),
  WATCHING:      new Set(['IDLE', 'PENDING_ENTRY', 'IN_TRADE', 'BLOCKED']),
  PENDING_ENTRY: new Set(['IDLE', 'WATCHING', 'IN_TRADE', 'BLOCKED']),
  IN_TRADE:      new Set(['COOLDOWN', 'IDLE', 'WATCHING', 'BLOCKED']),
  COOLDOWN:      new Set(['IDLE', 'WATCHING', 'BLOCKED']),
  BLOCKED:       new Set(['IDLE', 'WATCHING', 'PENDING_ENTRY', 'IN_TRADE']),
};

export function canTransitionAgent(from: AgentLifecycleState, to: AgentLifecycleState): boolean {
  return from === to || ALLOWED[from].has(to);
}

/**
 * Compute the state an agent SHOULD be in from live signals + positions — ignoring any sticky
 * override. Precedence: IN_TRADE > PENDING_ENTRY > WATCHING > IDLE. (An open position dominates;
 * a pending LIMIT next; an ACTIVE signal next; otherwise idle.)
 */
export async function deriveAgentState(db: Db, agentId: string): Promise<AgentLifecycleState> {
  const openPos = await db.select({ state: paperPosition.state })
    .from(paperPosition)
    .innerJoin(prediction, eq(prediction.id, paperPosition.predictionId))
    .where(and(
      eq(prediction.tradingAgentId, agentId),
      inArray(paperPosition.state, ['OPEN', 'PENDING_ENTRY']),
      eq(paperPosition.isShadow, false),
    ))
    .limit(5);
  if (openPos.some((p) => p.state === 'OPEN')) return 'IN_TRADE';
  if (openPos.some((p) => p.state === 'PENDING_ENTRY')) return 'PENDING_ENTRY';

  const activeSig = await db.select({ id: signal.id })
    .from(signal)
    .where(and(eq(signal.tradingAgentId, agentId), eq(signal.state, 'ACTIVE')))
    .limit(1);
  if (activeSig.length > 0) return 'WATCHING';

  return 'IDLE';
}

/** Read the stored lifecycle state (may be stale for derived states — call `refreshAgentState`). */
export async function getAgentState(db: Db, agentId: string): Promise<{ state: AgentLifecycleState; until: Date | null } | null> {
  const r = (await db.select({ state: tradingAgent.lifecycleState, until: tradingAgent.lifecycleUntil })
    .from(tradingAgent).where(eq(tradingAgent.id, agentId)).limit(1))[0];
  if (!r) return null;
  return { state: r.state as AgentLifecycleState, until: r.until };
}

/**
 * Recompute + persist the derived state, UNLESS the agent is currently in a sticky state that
 * hasn't expired. Called from the signal/position event handlers so the stored column tracks
 * reality. Returns the effective state after the refresh.
 */
export async function refreshAgentState(db: Db, agentId: string, now = new Date()): Promise<AgentLifecycleState> {
  const cur = await getAgentState(db, agentId);
  if (!cur) return 'IDLE';
  // A sticky state that hasn't reached its `until` wins — don't derive over it.
  if (STICKY.has(cur.state) && cur.until !== null && cur.until > now) return cur.state;
  // A sticky state with no timer (feed-staleness BLOCKED) is cleared explicitly elsewhere; keep it.
  if (cur.state === 'BLOCKED' && cur.until === null) return 'BLOCKED';
  const derived = await deriveAgentState(db, agentId);
  if (derived !== cur.state) {
    await db.update(tradingAgent).set({ lifecycleState: derived, lifecycleUntil: null }).where(eq(tradingAgent.id, agentId));
  }
  return derived;
}

/** Force a specific state — used for COOLDOWN (with an `until`) and BLOCKED. Validates the edge. */
export async function transitionAgentState(
  db: Db, agentId: string, to: AgentLifecycleState, opts: { until?: Date | null; force?: boolean } = {},
): Promise<AgentLifecycleState> {
  const cur = await getAgentState(db, agentId);
  if (!cur) throw new Error(`agent ${agentId} not found`);
  if (!opts.force && !canTransitionAgent(cur.state, to)) {
    throw new Error(`invalid agent lifecycle transition: ${cur.state} → ${to}`);
  }
  await db.update(tradingAgent)
    .set({ lifecycleState: to, lifecycleUntil: opts.until ?? null })
    .where(eq(tradingAgent.id, agentId));
  return to;
}

/** Enter COOLDOWN for `windowMs` after a position closes; auto-clears to the derived state. */
export async function enterCooldown(db: Db, agentId: string, windowMs: number, now = new Date()): Promise<void> {
  await transitionAgentState(db, agentId, 'COOLDOWN', { until: new Date(now.getTime() + windowMs), force: true });
}

/** External stop → BLOCKED. `until` null = indefinite (feed staleness); a date = auto-clear (daily loss → next UTC day). */
export async function blockAgent(db: Db, agentId: string, until: Date | null = null): Promise<void> {
  await transitionAgentState(db, agentId, 'BLOCKED', { until, force: true });
}

/** Clear BLOCKED/COOLDOWN back to the derived state — e.g. when a stale feed recovers. */
export async function unblockAgent(db: Db, agentId: string): Promise<AgentLifecycleState> {
  await db.update(tradingAgent).set({ lifecycleState: 'IDLE', lifecycleUntil: null }).where(eq(tradingAgent.id, agentId));
  return refreshAgentState(db, agentId);
}

/**
 * Sweep — clears every agent whose sticky timer has elapsed back to its derived state. Run
 * periodically (a scheduler) so COOLDOWN and daily-loss BLOCKED auto-recover without an event.
 * Returns the number of agents cleared.
 */
export async function tickLifecycle(db: Db, now = new Date()): Promise<number> {
  const expired = await db.select({ id: tradingAgent.id })
    .from(tradingAgent)
    .where(and(
      inArray(tradingAgent.lifecycleState, ['COOLDOWN', 'BLOCKED']),
      sql`${tradingAgent.lifecycleUntil} is not null`,
      lt(tradingAgent.lifecycleUntil, now),
    ));
  for (const a of expired) {
    await db.update(tradingAgent).set({ lifecycleState: 'IDLE', lifecycleUntil: null }).where(eq(tradingAgent.id, a.id));
    await refreshAgentState(db, a.id, now);
  }
  void or; void isNull;
  return expired.length;
}
