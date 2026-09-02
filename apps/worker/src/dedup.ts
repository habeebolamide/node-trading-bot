/**
 * Event-level dedup for the shared queue dispatchers (§29 — audit-2 finding: the registry was
 * empty, so every live consumer was a raw `bus.createWorker` with NO idempotency guard; a BullMQ
 * redelivery re-ran Judge LLM calls and position closes).
 *
 * Semantics — deliberately different from `withIdempotency` (which shares one transaction
 * between the claim and the effects, and is the right tool for single-purpose processors):
 * a dispatcher fans one event to several independent handlers, so one shared transaction isn't
 * available. Instead: claim FIRST (own transaction) → run handlers → on failure RELEASE the
 * claim and rethrow so BullMQ's retry works. The window this leaves open (crash after partial
 * handler effects, claim released, redelivery re-runs them) is exactly why every write inside
 * the handlers still carries its own DB-level guard (unique indexes, onConflictDoNothing,
 * idempotent closes) — this wrapper removes the COMMON re-run path, the constraints remove the
 * rest (§29, rule 12).
 */
import { eq } from 'drizzle-orm';
import { processedEvent, type Db } from '@tip/database';
import type { DomainEvent } from '@tip/domain';

export function withEventDedup(
  db: Db,
  handler: (event: DomainEvent) => Promise<void>,
): (event: DomainEvent) => Promise<void> {
  return async (event: DomainEvent): Promise<void> => {
    if (!event?.id) { await handler(event); return; } // malformed envelope — let the handler decide
    const claimed = await db.insert(processedEvent)
      .values({ eventId: event.id })
      .onConflictDoNothing()
      .returning({ eventId: processedEvent.eventId });
    if (claimed.length === 0) return; // duplicate delivery — already handled (or in flight)
    try {
      await handler(event);
    } catch (err) {
      // Release so BullMQ's retry can redeliver — a permanently-claimed failed event would be
      // silently dropped, which is the §10 "swallowed ingestion error" failure mode.
      await db.delete(processedEvent).where(eq(processedEvent.eventId, event.id)).catch(() => undefined);
      throw err;
    }
  };
}
