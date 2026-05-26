import logger from '../utils/logger.js';
import type { Candle }        from '../types/market.types.js';
import type { EntrySignal }   from '../types/claude.types.js';
import { prisma } from '../lib/prisma.js';
import { agentManager } from './index.js';
import { buildMtfData } from '../markets/mtf.js';
import { getCandleBuffer } from '../markets/websocket.js';
import { detectRegime } from '../markets/regime.js';
import { getNewsContextForPrompt } from '../markets/news.js';
import { notifications } from '../utils/notifications.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface Triggers {
  price_up:   number | null;
  price_down: number | null;
  timeout:    string | null;   // ISO 8601 UTC
}

export type TriggerResult =
  | { hit: false }
  | { hit: true; reason: 'PRICE_UP' | 'PRICE_DOWN' | 'TIMEOUT' | 'EXPIRY' };

// ─────────────────────────────────────────────
// Active trigger store per agent
// Keyed by agentId
// ─────────────────────────────────────────────

interface AgentTriggerState {
  triggers:      Triggers;
  pendingSignal: EntrySignal | null;   // null = NO_TRADE watching mode
  entryExpiry:   string | null;        // ISO 8601 — when pending entry expires
}

const store = new Map<string, AgentTriggerState>();


export async function setTriggersMemory(
  agentId:       string,
  triggers:      Triggers,
  pendingSignal: EntrySignal | null,
  entryExpiry:   string | null,
): Promise<void> {
  // Save to in-memory store
  store.set(agentId, {
    triggers,
    pendingSignal,
    entryExpiry,
  });

  logger.info('Signal saved to Memory', { agentId, action: pendingSignal?.action ?? 'NO_TRADE' });
}

// ─────────────────────────────────────────────
// Set triggers after a Gemini response
// Called by agent manager after every signal
// ─────────────────────────────────────────────

export async function setTriggers(
  agentId:       string,
  triggers:      Triggers,
  pendingSignal: EntrySignal | null,
  entryExpiry:   string | null,
  rawSignal:     any,
  positionSize:  number | null
): Promise<void> {
  // Save to in-memory store
  store.set(agentId, {
    triggers,
    pendingSignal,
    entryExpiry,
  });

  const agent = agentManager.getSingleAgent(agentId);
  const leverage = agent?.leverage ?? 10;

  // Stamp the signal with the active challenge session, if any. The websocket
  // entry-hit re-validation reads challengeId off this row to route through
  // the bucket sandbox — without this, realtime entries on a challenge agent
  // would silently fall back to main-pool validation. Critical.
  const activeSession = await prisma.challengeSession.findFirst({
    where:  { agentId, status: 'active' },
    select: { id: true, leverage: true },
  });
  const effectiveLeverage = activeSession?.leverage ?? leverage;

  // Persist to DB — survive restarts
  await prisma.signal.create({
    data: {
      agentId,
      action:         pendingSignal?.action ?? 'NO_TRADE',
      entry:          pendingSignal?.entry          ?? null,
      tp:             pendingSignal?.tp             ?? null,
      sl:             pendingSignal?.sl             ?? null,
      confidence:     pendingSignal?.confidence     ?? null,
      tradeStyle:     (pendingSignal as any)?.tradeStyle    ?? null,
      timeframeUsed:  (pendingSignal as any)?.timeframe_used ?? null,
      reasoning:      pendingSignal?.reasoning      ?? null,
      whatInvalidates:(pendingSignal as any)?.what_invalidates ?? null,
      entryExpiry:    entryExpiry ? new Date(entryExpiry) : null,
      triggers:       triggers as any,
      status:         'active',
      rawSignal,
      positionSize,
      leverage:       effectiveLeverage,
      pair:           agent?.pair ?? 'unknown',
      challengeId:    activeSession?.id ?? null,
    },
  });

  logger.info('Signal saved to DB', { agentId, action: pendingSignal?.action ?? 'NO_TRADE' });
}

// ─────────────────────────────────────────────
// Update triggers — called after every management cycle
// Updates the SAME signal record — never creates a new one
// System controls timeout. AI controls price_up/price_down.
// ─────────────────────────────────────────────
 
export async function updateTriggers(
  agentId:    string,
  newTriggers: Triggers,
): Promise<void> {
 
  // Update DB — find active signal by agentId
  await prisma.signal.updateMany({
    where: { agentId, status: 'active' },
    data:  { triggers: newTriggers as any },
  });
 
  // Update in-memory store
  const existing = store.get(agentId);
  if (existing) {
    existing.triggers = newTriggers;
  }
 
  logger.info('Triggers updated', {
    agentId,
    price_up:   newTriggers.price_up,
    price_down: newTriggers.price_down,
    timeout:    newTriggers.timeout,
  });
}

// ─────────────────────────────────────────────
// Clear triggers — call after a signal is consumed.
// Caller MUST specify how the signal transitioned (status + triggeredBy) so
// we never leave a row with status='cancelled' + triggeredBy=null, which
// would erase any record of why the signal ended.
// ─────────────────────────────────────────────

export interface TriggerTransition {
  status:      'triggered' | 'executed' | 'expired' | 'cancelled' | 'failed';
  triggeredBy: string;
}

export async function clearTriggers(
  agentId:    string,
  transition: TriggerTransition,
): Promise<void> {
  store.delete(agentId);

  await prisma.signal.updateMany({
    where:  { agentId, status: 'active' },
    data:   {
      status:      transition.status,
      triggeredBy: transition.triggeredBy,
      triggeredAt: new Date(),
    },
  });
}

// In-memory only — for callers that have already written the DB transition
// explicitly (e.g. realtime entry hit updates a single signal by id, then
// just needs the in-memory store cleared).
export function clearTriggerMemory(agentId: string): void {
  store.delete(agentId);
}


// ─────────────────────────────────────────────
// Get pending signal for an agent
// Used by agent manager to attach trade
// ─────────────────────────────────────────────

export function getPendingSignal(agentId: string): EntrySignal | null {
  return store.get(agentId)?.pendingSignal ?? null;
}

// ─────────────────────────────────────────────
// Atomic claim — synchronously returns state and removes it from the store
// in a single tick. Used by the realtime ticker to prevent double-execution
// when multiple concurrent invocations (or the candle-close path) see the
// same active signal during an executeEntry await window.
// Returns null if already claimed.
// ─────────────────────────────────────────────

export function claimTriggers(agentId: string): AgentTriggerState | null {
  const state = store.get(agentId);
  if (!state) return null;
  store.delete(agentId);
  return state;
}

// ─────────────────────────────────────────────
// Check triggers on every candle close
// Returns what was hit so the caller decides
// what to do — this module only detects
// ─────────────────────────────────────────────

export function checkTriggers(
  agentId: string,
  candle:  Candle,
): TriggerResult {
  const state = store.get(agentId);
  if (!state) return { hit: false };

  const { triggers, pendingSignal, entryExpiry } = state;
  const now  = Date.now();
  const high = candle.high;
  const low  = candle.low;

  // ── PENDING_ENTRY — only check expiry ──
  // Entry fills are handled exclusively by the realtime ticker path in
  // websocket.ts so they fire on the first qualifying tick, the same way TP/SL
  // fire — never waiting for a candle to close.
  if (pendingSignal) {
    if (entryExpiry) {
      const expiryTime = new Date(entryExpiry).getTime();
      if (!isNaN(expiryTime) && now > expiryTime) {
        return { hit: true, reason: 'EXPIRY' };
      }
    }
    return { hit: false };
  }

  // ── WATCHING (NO_TRADE) — check all three ──
  // ── IN_TRADE — check price_up and price_down only ──

  // Timeout (WATCHING only — IN_TRADE never has timeout)
  if (triggers.timeout) {
    const timeoutTime = new Date(triggers.timeout).getTime();
    if (!isNaN(timeoutTime) && now > timeoutTime) {
      return { hit: true, reason: 'TIMEOUT' };
    }
  }

  // Price up
  if (triggers.price_up != null && high >= triggers.price_up) {
    return { hit: true, reason: 'PRICE_UP' };
  }

  // Price down
  if (triggers.price_down != null && low <= triggers.price_down) {
    return { hit: true, reason: 'PRICE_DOWN' };
  }

  return { hit: false };
}

// ─────────────────────────────────────────────
// Check if agent has active triggers
// ─────────────────────────────────────────────

export function hasTriggers(agentId: string): boolean {
  const state = store.get(agentId);
  if (!state) return false;

  const { triggers, pendingSignal, entryExpiry } = state;

  // PENDING_ENTRY: pendingSignal + entryExpiry drive the wait — even with all
  // price/timeout triggers null, checkTriggers must still run to detect entry hit.
  if (pendingSignal !== null || entryExpiry !== null) return true;

  return (
    triggers.price_up !== null ||
    triggers.price_down !== null ||
    triggers.timeout !== null
  );
}

// ─────────────────────────────────────────────
// Get full trigger state — for logging/dashboard
// ─────────────────────────────────────────────

export function getTriggerState(agentId: string): AgentTriggerState | null {
  return store.get(agentId) ?? null;
}

export function startTimeoutChecker(): void {
  setInterval(async () => {
    const agents = agentManager.getAllAgents();

    for (const agent of agents) {
      if (!hasTriggers(agent.id)) continue;
      // if (agent.state === 'IN_TRADE') continue; // IN_TRADE has no timeout

      const state = getTriggerState(agent.id);
      if (!state) continue;

      // ── Pending entry expiry — backup path for pairs with no recent ticker
      //    activity (realtime ticker is the primary detector). Without this,
      //    a quiet pair would keep a pending entry "alive" past its deadline
      //    until the next 5m candle closed.
      if (state.pendingSignal && state.entryExpiry) {
        const expiryMs = new Date(state.entryExpiry).getTime();
        if (!isNaN(expiryMs) && Date.now() >= expiryMs) {
          logger.info(`[${agent.name}] Entry expired (timeout checker)`, {
            entryExpiry: state.entryExpiry,
          });

          const expiredSignal = state.pendingSignal;

          await prisma.signal.updateMany({
            where: { agentId: agent.id, status: 'active' },
            data:  {
              status:      'expired',
              triggeredBy: 'EXPIRY',
              triggeredAt: new Date(),
            },
          });

          store.delete(agent.id);
          agent.setState('IDLE');

          await notifications.sendExpiryAlert(agent as any, expiredSignal);
          continue;
        }
      }

      if (!state.triggers.timeout) continue;

      const timeoutTime = new Date(state.triggers.timeout).getTime();
      if (Date.now() < timeoutTime) continue;

      // Timeout expired — need fresh MTF data to re-analyse
      const pairs     = [agent.pair];
      const mtfData   = buildMtfData(agent.pair);
      const buffer    = getCandleBuffer(agent.pair, '60');
      const regime    = detectRegime(buffer);
      const newsContext = getNewsContextForPrompt(agent.pair);

      if (!mtfData || !regime) continue;

      logger.info(`[${agent.name}] Timeout trigger fired`, {
        timeout: state.triggers.timeout,
      });

      // No clearTriggers here — handleTriggerHit's TIMEOUT case does the DB
      // transition with the right (status, triggeredBy) pair. Calling it twice
      // would either double-write or overwrite the explicit transition with
      // a fallback default.
      if (agent.state === 'WATCHING') {
        agent.setState('IDLE');
        agent.needsReanalysis = true;
      }

      // Build a fake candle just to pass to handleTriggerHit
      // We don't actually need candle data for TIMEOUT — just state
      await agentManager.handleTriggerHit(
        agent,
        'TIMEOUT',
        null as any,
        mtfData,
        regime,
        newsContext,
      );
    }
  }, 30_000); // check every 60 seconds — precise enough
}


