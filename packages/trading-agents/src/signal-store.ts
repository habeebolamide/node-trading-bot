/**
 * Signal persistence (§9, §19 rule 10). Insert Signal + per-agent signal_feature rows in one
 * transaction. `fingerprint` has a DB-level unique constraint — a duplicate insert (same
 * TradingAgent + same symbol + same direction + same tf-close-minute) hits the constraint and
 * is silently skipped, matching §9 correlation.
 */
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { signal, signalFeature, type Db } from '@tip/database';
import type { AgentOutput } from './agent-interface.js';
import type { Domain } from './identity.js';
import type { Direction } from './scoring.js';

export interface CreateSignalInput {
  tradingAgentId: string;
  symbol: string;
  domain: Domain;
  direction: Direction;
  compositeScore: number;
  confidence: number;
  createdAt: Date;
  expiresAt: Date;
  configVersion: number;
  fingerprint: string;
  evidence: Record<string, unknown>;
  contributions: readonly AgentOutput[];
}

export interface CreateSignalResult {
  signalId: string | null; // null when the fingerprint already exists (dedup no-op)
  created: boolean;
}

export type SignalState = 'ACTIVE' | 'EXPIRED' | 'INVALIDATED' | 'CONSUMED';

/**
 * Insert a Signal and its per-agent signal_feature rows atomically. Returns
 * `{ created: false, signalId: null }` if the fingerprint already exists — no throw.
 */
export async function createSignal(db: Db, input: CreateSignalInput): Promise<CreateSignalResult> {
  const id = randomUUID();
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(signal)
      .values({
        id,
        tradingAgentId: input.tradingAgentId,
        symbol: input.symbol,
        domain: input.domain,
        direction: input.direction,
        compositeScore: String(input.compositeScore),
        confidence: String(input.confidence),
        state: 'ACTIVE',
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        configVersion: input.configVersion,
        fingerprint: input.fingerprint,
        evidence: input.evidence,
      })
      .onConflictDoNothing({ target: signal.fingerprint })
      .returning({ id: signal.id });

    const created = inserted.length > 0;
    if (!created) return { signalId: null, created: false };

    if (input.contributions.length > 0) {
      await tx.insert(signalFeature).values(
        input.contributions.map((o) => ({
          signalId: id,
          agentKey: o.agent,
          agentVersion: o.agentVersion,
          score: String(o.score),
          confidence: String(o.confidence),
          features: o.features,
        })),
      );
    }
    return { signalId: id, created: true };
  });
}

/** Transition a Signal to a new lifecycle state (§36). Idempotent — no-op if already in state. */
export async function transitionSignal(db: Db, signalId: string, to: SignalState): Promise<boolean> {
  const r = await db
    .update(signal)
    .set({ state: to })
    .where(and(eq(signal.id, signalId)))
    .returning({ id: signal.id });
  return r.length > 0;
}
