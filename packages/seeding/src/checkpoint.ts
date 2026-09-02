/**
 * Resumability checkpoint (§25 design.md — "Resumability matters more than speed.").
 *
 * An interrupted seed run resumes exactly where it left off — cheap for the operator, cheap for
 * the DB (no re-writing already-resolved outcomes). Two structural mechanisms make this safe:
 *
 * 1. The `predictionOutcome` PK `(prediction_id, horizon)` and the `brain_setup_occurrence`
 *    unique `(prediction_id, setup_id)` (M5) already guarantee idempotency at the DB level.
 *    Even without a checkpoint, re-running a completed range writes ZERO new rows.
 * 2. The checkpoint lives in `domain_event` as a small marker so operational tools can inspect
 *    it without a new table. Sufficient for MVP: one run tracks one (symbol, style, agent)
 *    tuple.
 */
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { domainEvent, type Db } from '@tip/database';

const CHECKPOINT_EVENT = 'brain-seeding.checkpoint';

export interface Checkpoint {
  readonly symbol: string;
  readonly style: string;
  readonly agentId: string;
  readonly cursor: Date;
  readonly writtenAt: Date;
}

export async function readCheckpoint(
  db: Db,
  input: { symbol: string; style: string; agentId: string },
): Promise<Checkpoint | null> {
  const rows = await db
    .select()
    .from(domainEvent)
    .where(eq(domainEvent.type, CHECKPOINT_EVENT))
    .orderBy(desc(domainEvent.eventTime))
    .limit(50);
  for (const r of rows) {
    const p = r.payload as Checkpoint | undefined;
    if (p && p.symbol === input.symbol && p.style === input.style && p.agentId === input.agentId) {
      // Deserialize dates
      return { ...p, cursor: new Date(p.cursor), writtenAt: new Date(p.writtenAt) };
    }
  }
  return null;
}

export async function writeCheckpoint(db: Db, cp: Checkpoint): Promise<void> {
  await db.insert(domainEvent).values({
    id: randomUUID(),
    type: CHECKPOINT_EVENT,
    eventTime: cp.writtenAt,
    processingTime: new Date(),
    source: 'brain-seeding',
    payload: cp,
  });
}
