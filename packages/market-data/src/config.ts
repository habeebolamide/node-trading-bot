import { z } from 'zod';
import { marketSchema } from '../../core/src/index.js';
import { timeframeSchema } from './contracts.js';
export const watchlistSchema = z
  .array(
    z
      .object({
        market: marketSchema,
        minClosedCandlesByTimeframe: z
          .record(timeframeSchema, z.number().int().min(1).max(10000))
          .refine((v) => Object.keys(v).length > 0),
      })
      .strict(),
  )
  .max(25);
export function marketDataConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    watchlist: watchlistSchema.parse(
      JSON.parse(env.MARKET_DATA_WATCHLIST ?? '[]'),
    ),
    heartbeatMaxAgeMs: z.coerce
      .number()
      .int()
      .min(1000)
      .max(300000)
      .parse(env.MARKET_HEARTBEAT_MAX_AGE_MS ?? 65000),
    repairIntervalMs: z.coerce
      .number()
      .int()
      .min(1000)
      .max(60000)
      .parse(env.MARKET_REPAIR_INTERVAL_MS ?? 5000),
  };
}
