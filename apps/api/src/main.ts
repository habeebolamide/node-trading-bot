import { createServer } from 'node:http';
import { getConfig, loadEnv } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { createRedis, EventBus } from '@tip/events';
import { createApp } from './app.js';

/** Boot the API: validate env, wire real connections, listen, wire shutdown. */
async function main(): Promise<void> {
  loadEnv(); // hydrate process.env from repo-root .env (no-op in production)
  const config = getConfig(); // validates env; throws FatalError if bad
  const db = getDb();
  const redis = createRedis(config.REDIS_URL);
  const bus = new EventBus(createRedis(config.REDIS_URL)); // bus owns its own connection

  const app = createApp({
    db,
    redis,
    bus,
    webhookSecret: config.HELIUS_WEBHOOK_SECRET,
    startedAt: Date.now(),
  });

  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(config.API_PORT, resolve));
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${config.API_PORT}`);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[api] ${signal} — shutting down`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await bus.close();
    await redis.quit();
    await closeDb(db);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[api] fatal on startup:', err);
  process.exit(1);
});
