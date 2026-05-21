import logger from '../utils/logger';
import type { Candle }        from '../types/market.types';
import type { EntrySignal }   from '../types/claude.types';
import { prisma } from '../lib/prisma';
import { agentManager } from '.';
import { buildMtfData } from '../markets/mtf';
import { getCandleBuffer } from '../markets/websocket';
import { detectRegime } from '../markets/regime';
import { getNewsContextForPrompt } from '../markets/news';

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
  | { hit: true; reason: 'PRICE_UP' | 'PRICE_DOWN' | 'TIMEOUT' | 'ENTRY_HIT' | 'EXPIRY' };

// ─────────────────────────────────────────────
// Active trigger store per agent
// Keyed by agentId
// ─────────────────────────────────────────────

interface AgentTriggerState {
  triggers:      Triggers;
  pendingSignal: EntrySignal | null;   // null = NO_TRADE watching mode
  entryExpiry:   string | null;        // ISO 8601 — when pending entry expires
  setAt:         number;               // Date.now() when triggers were set
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
    setAt: Date.now(),
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
    setAt: Date.now(),
  });

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
      positionSize
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
// Clear triggers — call after trade opens,
// signal expires, or re-analysis is triggered
// ─────────────────────────────────────────────

export async function clearTriggers(
  agentId:     string,
  triggeredBy?: string,
): Promise<void> {
  store.delete(agentId);

  // Mark active signal as triggered/expired in DB
  await prisma.signal.updateMany({
    where:  { agentId, status: 'active' },
    data:   {
      status:      triggeredBy ? 'triggered' : 'cancelled',
      triggeredBy: triggeredBy ?? null,
      triggeredAt: new Date(),
    },
  });
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

  const { triggers, pendingSignal, entryExpiry, setAt } = state;
  const now  = Date.now();
  const high = candle.high;
  const low  = candle.low;

  // A candle whose open time is BEFORE the signal was set straddles the signal-
  // creation moment. Its high/low can include wicks from before the signal
  // existed — using that range to fire ENTRY_HIT would be like a broker filling
  // your limit order based on price action that happened before you placed it.
  // The realtime ticker covers post-signal intra-candle moves; skip pre-signal
  // candle-close detection.
  const candlePredatesSignal = candle.openTime < setAt;

  // ── PENDING_ENTRY — only check entry hit and expiry ──
  if (pendingSignal) {

    // Entry hit — only on candles that opened AFTER the signal was set
    if (pendingSignal.entry != null && !candlePredatesSignal) {
      const entryHit =
        pendingSignal.action === 'LONG'
          ? low  <= pendingSignal.entry && high >= pendingSignal.entry
          : high >= pendingSignal.entry && low  <= pendingSignal.entry;

      if (entryHit) return { hit: true, reason: 'ENTRY_HIT' };
    }

    // Entry expiry — time-based check, candle-position irrelevant
    if (entryExpiry) {
      const expiryTime = new Date(entryExpiry).getTime();
      if (!isNaN(expiryTime) && now > expiryTime) {
        return { hit: true, reason: 'EXPIRY' };
      }
    }

    // Nothing hit for pending entry
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
      if (!state?.triggers.timeout) continue;

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

      clearTriggers(agent.id);

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


