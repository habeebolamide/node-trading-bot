import { Redis, type RedisOptions } from 'ioredis';

/**
 * Create an ioredis connection suitable for BullMQ. `maxRetriesPerRequest: null`
 * is required by BullMQ (blocking commands must not be capped), and Upstash-style
 * `rediss://` URLs carry their own TLS config in the URL.
 */
export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...options,
  });
}
