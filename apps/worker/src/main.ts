import { getConfig } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { createRedis, EventBus } from '@tip/events';
import { startWorkers } from './runner.js';
// Side-effect imports that register processors go here as milestones add them, e.g.:
//   import '@tip/ingestion/register';

async function main(): Promise<void> {
  const config = getConfig(); // validates env; throws FatalError if bad
  const db = getDb();
  const bus = new EventBus(createRedis(config.REDIS_URL));

  const workers = startWorkers(bus, db);
  // eslint-disable-next-line no-console
  console.log(`[worker] started ${workers.length} worker(s)`);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[worker] ${signal} — draining`);
    await bus.close(); // stops accepting, finishes in-flight
    await closeDb(db);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[worker] fatal on startup:', err);
  process.exit(1);
});
