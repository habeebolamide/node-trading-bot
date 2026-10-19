import { createServer } from 'node:http';
import { configFromEnv, createLogger } from '../packages/core/src/index.js';
import { connectDatabase } from '../packages/database/src/index.js';
// Scaffold only: reports process/database health, never claims trading readiness.
export function runScaffold(service: 'runtime' | 'worker') {
  const config = configFromEnv();
  const log = createLogger(service, config.LOG_LEVEL);
  const { pool } = connectDatabase(config.DATABASE_URL);
  const port =
    service === 'runtime'
      ? config.RUNTIME_HEALTH_PORT
      : config.WORKER_HEALTH_PORT;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health/live') {
      res.end(
        JSON.stringify({
          status: 'alive',
          service,
          capabilities: [],
          phase: 1,
        }),
      );
      return;
    }
    if (req.url === '/health/ready') {
      let database = 'available';
      try {
        await pool.query('select 1');
      } catch {
        database = 'unavailable';
      }
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          status: 'not_ready',
          database,
          service,
          reason: 'Phase 1 scaffold; trading and jobs are not implemented',
          acceptsNewEntries: false,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }).listen(port, '127.0.0.1', () =>
    log.info(
      { port, correlationId: crypto.randomUUID() },
      'scaffold listening',
    ),
  );
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
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
  return server;
}
