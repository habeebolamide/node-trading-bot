import type { Db } from './client.js';
import { processedEvent } from './schema.js';

/** The transaction handle Drizzle hands a `db.transaction(fn)` callback. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Run a consumer's effects exactly-once for a given event id (§29, rule 12).
 *
 * The claim insert into `processed_event` and the handler's writes share ONE
 * transaction:
 *   - If the id is new, the insert succeeds and `fn(tx)` runs. All writes commit
 *     together.
 *   - If the id was already processed, the insert hits the PK and returns zero
 *     rows → we skip `fn` entirely.
 *   - If `fn` throws, the whole transaction rolls back — including the claim — so
 *     the event is genuinely un-processed and a retry will re-attempt it. This is
 *     the at-least-once → exactly-once guarantee, enforced structurally rather
 *     than by a check-then-write.
 *
 * `fn` MUST perform its writes through the passed `tx`, not a fresh `db` handle,
 * or they won't be covered by the atomic claim.
 *
 * @returns `{ processed: true }` if the handler ran, `{ processed: false }` if it
 *          was a duplicate and was skipped.
 */
export async function withIdempotency(
  db: Db,
  eventId: string,
  fn: (tx: Tx) => Promise<void>,
): Promise<{ processed: boolean }> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(processedEvent)
      .values({ eventId })
      .onConflictDoNothing()
      .returning({ eventId: processedEvent.eventId });

    if (claimed.length === 0) {
      return { processed: false }; // duplicate — someone already handled this id
    }

    await fn(tx);
    return { processed: true };
  });
}
