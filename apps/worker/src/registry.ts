import type { DomainEvent } from '@tip/domain';
import type { Tx } from '@tip/database';
import type { QueueName } from '@tip/events';

/**
 * A queue processor. Receives the event and the idempotency transaction — ALL
 * writes must go through `tx` so they commit atomically with the processed_event
 * claim (§29). The runner wraps every processor with withIdempotency, so a
 * processor never worries about dedup itself.
 */
export type Processor<T = unknown> = (event: DomainEvent<T>, tx: Tx) => Promise<void>;

/**
 * The registry other milestones push into. Empty in m1-foundation-core — the
 * providers (m1-bybit-adapter, m1-helius-adapter) and later the analysis tier
 * register their processors here. One processor per queue for now; a queue that
 * fans to several concerns composes them behind a single registered processor.
 */
const registry = new Map<QueueName, Processor>();

/** Register the processor for a queue. Throws if one is already registered (catch double-wiring). */
export function register<T>(queue: QueueName, processor: Processor<T>): void {
  if (registry.has(queue)) {
    throw new Error(`processor already registered for queue "${queue}"`);
  }
  registry.set(queue, processor as Processor);
}

/** All registered [queue, processor] pairs, for the runner to spin up workers. */
export function registeredProcessors(): ReadonlyArray<[QueueName, Processor]> {
  return [...registry.entries()];
}

/** Test-only: clear the registry between cases. */
export function clearRegistryForTests(): void {
  registry.clear();
}
