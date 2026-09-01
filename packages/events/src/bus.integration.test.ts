import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { createRedis } from './connection.js';
import { EventBus } from './bus.js';
import { PRIORITY, type QueueName } from './queues.js';

// Integration: requires a real Redis. Skips cleanly when REDIS_URL is unset so
// the unit suite still runs on a bare checkout. Set REDIS_URL to exercise it.
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('EventBus (integration, Redis)', () => {
  const connection = createRedis(REDIS_URL!);
  const bus = new EventBus(connection);
  const queue = `analytics-test-${randomUUID()}` as QueueName;

  afterAll(async () => {
    await bus.close();
    await new Queue(queue, { connection }).obliterate({ force: true });
    await connection.quit();
  });

  it('serves a FAST job before an older NORMAL job (§11 fast lane)', async () => {
    const order: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    // Register a paused worker first, then enqueue NORMAL *before* FAST.
    const worker = bus.createWorker<{ tag: string }>(
      queue,
      async (event) => {
        order.push(event.payload.tag);
        if (order.length === 2) resolveDone();
      },
      { autorun: false, concurrency: 1 },
    );

    await bus.publish(queue, {
      type: 'analytics.test', eventTime: new Date().toISOString(), source: 't', payload: { tag: 'normal' },
    }, { priority: PRIORITY.NORMAL });
    await bus.publish(queue, {
      type: 'analytics.test', eventTime: new Date().toISOString(), source: 't', payload: { tag: 'fast' },
    }, { priority: PRIORITY.FAST });

    void worker.run();
    await done;

    expect(order).toEqual(['fast', 'normal']);
  }, 20_000);
});
