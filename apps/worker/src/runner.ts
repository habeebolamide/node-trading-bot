import type { Worker } from 'bullmq';
import type { DomainEvent } from '@tip/domain';
import { withIdempotency, type Db } from '@tip/database';
import type { EventBus } from '@tip/events';
import { registeredProcessors, type Processor } from './registry.js';

/**
 * Wrap a processor so every event is handled exactly-once: the processor's writes
 * and the processed_event claim share one transaction (§29). A duplicate event id
 * is skipped silently.
 */
export function wrapProcessor(db: Db, processor: Processor): (event: DomainEvent) => Promise<void> {
  return async (event) => {
    await withIdempotency(db, event.id, (tx) => processor(event, tx));
  };
}

/** Spin up one BullMQ worker per registered processor. Returns them for shutdown. */
export function startWorkers(bus: EventBus, db: Db): Worker[] {
  return registeredProcessors().map(([queue, processor]) =>
    bus.createWorker(queue, wrapProcessor(db, processor)),
  );
}
