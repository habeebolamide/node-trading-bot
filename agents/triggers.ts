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


// In agents/triggers.ts — add this export

export async function resumeActiveSignals(agentIds: string[]): Promise<void> {
  logger.info('Resuming active signals from DB');

  const activeSignals = await prisma.signal.findMany({
    where: {
      agentId: { in: agentIds },
      status:  'active',
    },
  });

  for (const row of activeSignals) {
    const triggers = row.triggers as unknown as Triggers;
    
    // Check if timeout or entry_expiry already passed while bot was down
    const now = Date.now();

    if (triggers.timeout) {
      const timeoutTime = new Date(triggers.timeout).getTime();
      if (now > timeoutTime) {
        // Expired while bot was offline — mark as expired
        await prisma.signal.update({
          where: { id: row.id },
          data:  { status: 'expired', triggeredBy: 'TIMEOUT', triggeredAt: new Date() },
        });
        logger.info('Signal expired during downtime', { agentId: row.agentId });
        continue;
      }
    }

    if (row.entryExpiry) {
      const expiryTime = new Date(row.entryExpiry).getTime();
      if (now > expiryTime) {
        await prisma.signal.update({
          where: { id: row.id },
          data:  { status: 'expired', triggeredBy: 'EXPIRY', triggeredAt: new Date() },
        });
        logger.info('Entry expired during downtime', { agentId: row.agentId });
        continue;
      }
    }

    // Signal still valid — restore to in-memory store
    const pendingSignal = row.action !== 'NO_TRADE'
      ? {
          action:           row.action,
          entry:            row.entry,
          tp:               row.tp,
          sl:               row.sl,
          confidence:       row.confidence,
          reasoning:        row.reasoning,
          timeframe_used:   row.timeframeUsed,
          what_invalidates: row.whatInvalidates,
          tradeStyle:       row.tradeStyle,
        } as unknown as EntrySignal
      : null;

    store.set(row.agentId, {
      triggers,
      pendingSignal,
      entryExpiry: row.entryExpiry?.toISOString() ?? null,
      setAt:       row.createdAt.getTime(),
    });

    logger.info('Signal resumed', {
      agentId: row.agentId,
      action:  row.action,
      status:  pendingSignal ? 'PENDING_ENTRY' : 'WATCHING',
    });
  }

  logger.info('Signal resume complete', { count: activeSignals.length });
}

// ─────────────────────────────────────────────
// Get pending signal for an agent
// Used by agent manager to attach trade
// ─────────────────────────────────────────────

export function getPendingSignal(agentId: string): EntrySignal | null {
  return store.get(agentId)?.pendingSignal ?? null;
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

  // ── PENDING_ENTRY — only check entry hit and expiry ──
  if (pendingSignal) {

    // Entry hit
    if (pendingSignal.entry != null) {
      const entryHit =
        pendingSignal.action === 'LONG'
          ? low  <= pendingSignal.entry && high >= pendingSignal.entry
          : high >= pendingSignal.entry && low  <= pendingSignal.entry;

      if (entryHit) return { hit: true, reason: 'ENTRY_HIT' };
    }

    // Entry expiry
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
  if (!state || !state.triggers) return false;

  const { price_up, price_down, timeout } = state.triggers;

  return (
    price_up !== null ||
    price_down !== null ||
    timeout !== null
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


