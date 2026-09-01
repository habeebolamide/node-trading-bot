import { getConfig, loadEnv } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { createRedis, EventBus } from '@tip/events';
import {
  BybitAdapter,
  BybitRestClient,
  AccountRatioPoller,
  FeedMonitor,
  DEFAULT_PERP_SYMBOLS,
  DEFAULT_TIMEFRAMES,
} from '@tip/ingestion';
import { startWorkers } from './runner.js';
// Side-effect imports that register queue processors go here as milestones add them.

/* eslint-disable no-console */
async function main(): Promise<void> {
  loadEnv(); // hydrate process.env from repo-root .env (no-op in production)
  const config = getConfig(); // validates env; throws FatalError if bad
  const db = getDb();
  const bus = new EventBus(createRedis(config.REDIS_URL));

  const workers = startWorkers(bus, db);
  console.log(`[worker] started ${workers.length} queue worker(s)`);

  // ── Bybit market-data ingestion (M1) ──────────────────────────
  const symbols = [...DEFAULT_PERP_SYMBOLS];
  const timeframes = [...DEFAULT_TIMEFRAMES];
  const monitor = new FeedMonitor({
    onStale: (id, age) => console.warn(`[staleness] ${id} STALE (${Math.round(age / 1000)}s since last msg)`),
    onRecover: (id, down) => console.log(`[staleness] ${id} recovered (was down ~${Math.round(down / 1000)}s)`),
  });
  const adapter = new BybitAdapter({
    bus,
    db,
    monitor,
    symbols,
    timeframes,
    testnet: config.BYBIT_TESTNET,
    log: (level, msg) => (level === 'warn' ? console.warn : console.log)(`[bybit] ${msg}`),
  });
  const poller = new AccountRatioPoller({
    rest: new BybitRestClient({ testnet: config.BYBIT_TESTNET }),
    bus,
    monitor,
    symbols,
    log: (level, msg) => (level === 'warn' ? console.warn : console.log)(`[bybit-poll] ${msg}`),
  });

  adapter.start();
  poller.start();
  const monitorTimer = setInterval(() => monitor.check(), 5_000);
  console.log(`[worker] bybit ingestion live for ${symbols.join(', ')}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} — draining`);
    clearInterval(monitorTimer);
    poller.stop();
    adapter.stop();
    await bus.close(); // stops accepting, finishes in-flight
    await closeDb(db);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[worker] fatal on startup:', err);
  process.exit(1);
});
