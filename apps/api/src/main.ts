import {
  configFromEnv,
  createLogger,
} from '../../../packages/core/src/index.js';
import { connectDatabase } from '../../../packages/database/src/index.js';
import { createApp } from './app.js';
const config = configFromEnv();
const log = createLogger('api', config.LOG_LEVEL);
const { db, pool } = connectDatabase(config.DATABASE_URL);
const server = createApp(db, pool, log).listen(
  config.API_PORT,
  config.API_HOST,
  () =>
    log.info({ port: config.API_PORT, node: process.version }, 'API listening'),
);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      await pool.end();
      clearTimeout(timeout);
      process.exit(0);
    });
  });
