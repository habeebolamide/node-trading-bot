import { randomUUID } from 'node:crypto';
import { Queue, Worker, UnrecoverableError, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { isRetryable, type DomainEvent, type NewDomainEvent } from '@tip/domain';
import { PRIORITY, type QueueName } from './queues.js';

export interface PublishOptions {
  /** BullMQ priority; defaults to NORMAL. Use PRIORITY.FAST for the reaction lane. */
  priority?: number;
  /** Override the per-job options (attempts, backoff, ...). */
  jobOptions?: JobsOptions;
}

export interface WorkerOptions {
  concurrency?: number;
  /** Start processing immediately (default true). Set false to add-then-run in tests. */
  autorun?: boolean;
}

/** Default retry policy — only RetryableError actually gets these attempts (see below). */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

/**
 * The one place that touches BullMQ job APIs (§11, rule 19) — everything else
 * publishes/subscribes through this, so the transport is swappable and the
 * envelope is built consistently (ids and clocks never hand-rolled by producers).
 *
 * Retry semantics honor the @tip/domain error hierarchy: a RetryableError is
 * retried per the attempts policy; anything else is wrapped in BullMQ's
 * UnrecoverableError so it fails fast without burning retries (a FatalError or
 * ValidationError won't fix itself on a retry).
 */
export class EventBus {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];

  constructor(private readonly connection: Redis) {}

  private getQueue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, q);
    }
    return q;
  }

  /**
   * Stamp `id`/`processingTime`/`version` onto a producer's event and enqueue it.
   * `jobId = event.id` gives a first dedup layer (BullMQ drops a duplicate jobId);
   * the durable second layer is withIdempotency at the consumer (@tip/database).
   */
  async publish<T>(
    queue: QueueName,
    event: NewDomainEvent<T>,
    opts: PublishOptions = {},
  ): Promise<DomainEvent<T>> {
    const full: DomainEvent<T> = {
      ...event,
      id: randomUUID(),
      version: event.version ?? 1,
      processingTime: new Date().toISOString(),
    };
    await this.getQueue(queue).add(full.type, full, {
      jobId: full.id,
      priority: opts.priority ?? PRIORITY.NORMAL,
      ...opts.jobOptions,
    });
    return full;
  }

  /** Register a consumer for a queue. The handler receives the full envelope. */
  createWorker<T = unknown>(
    queue: QueueName,
    handler: (event: DomainEvent<T>) => Promise<void>,
    opts: WorkerOptions = {},
  ): Worker {
    const worker = new Worker(
      queue,
      async (job) => {
        try {
          await handler(job.data as DomainEvent<T>);
        } catch (err) {
          if (isRetryable(err)) throw err; // transient — let BullMQ retry
          // Non-retryable: fail immediately, don't waste the attempts budget.
          throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
        }
      },
      {
        connection: this.connection,
        concurrency: opts.concurrency ?? 1,
        autorun: opts.autorun ?? true,
      },
    );
    this.workers.push(worker);
    return worker;
  }

  /** Close all workers and queues (not the shared connection — its owner closes it). */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
