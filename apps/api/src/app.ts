import express, { type Express, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Db } from '@tip/database';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import type { Watchlist } from '@tip/watchlist';
import { safeEqual, withTimeout } from './util.js';
import { walletsRouter } from './wallets.js';
import { tradingAgentsRouter } from './trading-agents.js';
import { dashboardRouter } from './dashboard.js';

export interface ApiDeps {
  db: Db;
  redis: Redis;
  bus: EventBus;
  /** Shared secret Helius sends in the Authorization header. Undefined = webhook disabled. */
  webhookSecret: string | undefined;
  /** Watchlist service (m3-watchlist). Undefined = /wallets endpoints disabled. */
  watchlist?: Watchlist;
  /** Process start time for uptime reporting. */
  startedAt?: number;
}

const PING_TIMEOUT_MS = 3000;

/**
 * Build the Express app with dependencies injected, so tests can pass fakes and
 * boot logic (config, real connections) stays in main.ts. No `process.env` here.
 */
export function createApp(deps: ApiDeps): Express {
  const app = express();
  const startedAt = deps.startedAt ?? Date.now();

  // Capture the raw body so a future signature scheme can verify bytes, while
  // still parsing JSON for convenience.
  app.use(express.json({ limit: '2mb' }));

  // Watchlist routes (m3-watchlist). Mounted only when a Watchlist service is provided.
  if (deps.watchlist) app.use('/wallets', walletsRouter(deps.watchlist));

  // TradingAgent routes (m4-tradingagent). Always mounted — needs only DB access.
  app.use('/trading-agents', tradingAgentsRouter(deps.db));
  app.use('/api', dashboardRouter(deps.db));

  // ── Liveness + dependency health ──────────────────────────────
  app.get('/health', async (_req: Request, res: Response) => {
    const [dbOk, redisOk] = await Promise.all([
      withTimeout(deps.db.execute(sql`select 1`), PING_TIMEOUT_MS, 'db ping')
        .then(() => true)
        .catch(() => false),
      withTimeout(deps.redis.ping(), PING_TIMEOUT_MS, 'redis ping')
        .then((r) => r === 'PONG')
        .catch(() => false),
    ]);
    const ok = dbOk && redisOk;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'fail',
      redis: redisOk ? 'ok' : 'fail',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  // ── Helius webhook receiver (§Part II §7) ─────────────────────
  // Authenticate, enqueue the RAW body for the Helius adapter to parse, return
  // 200 fast. No parsing here — the un-normalized payload must not masquerade as
  // a domain event (§12); it rides as the payload of a HELIUS_WEBHOOK_RECEIVED
  // marker on the blockchain-ingestion queue.
  app.post('/webhooks/helius', async (req: Request, res: Response) => {
    if (!deps.webhookSecret) {
      res.status(503).json({ error: 'webhook not configured (HELIUS_WEBHOOK_SECRET unset)' });
      return;
    }
    const provided = req.header('authorization') ?? '';
    if (!safeEqual(provided, deps.webhookSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    try {
      await deps.bus.publish(QUEUE_NAMES.BLOCKCHAIN_INGESTION, {
        type: EVENT_NAMES.HELIUS_WEBHOOK_RECEIVED,
        eventTime: new Date().toISOString(),
        source: 'helius-webhook',
        payload: req.body as unknown,
      });
      res.status(200).json({ received: true });
    } catch {
      // Enqueue failed (Redis down) — tell Helius to retry rather than drop.
      res.status(503).json({ error: 'ingestion queue unavailable' });
    }
  });

  return app;
}
