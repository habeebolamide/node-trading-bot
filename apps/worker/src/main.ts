import { createServer } from 'node:http';
import {
  configFromEnv,
  createLogger,
} from '../../../packages/core/src/index.js';
import { connectDatabase } from '../../../packages/database/src/index.js';
import { sql } from 'drizzle-orm';
import { executeReplay } from '../../../packages/replay/src/runner.js';
const config = configFromEnv(),
  log = createLogger('worker', config.LOG_LEVEL),
  { db, pool } = connectDatabase(config.DATABASE_URL),
  controller = new AbortController();
let busy: Promise<void> | null = null;
async function poll() {
  if (busy || controller.signal.aborted) return;
  busy = (async () => {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM replay_runs WHERE status IN ('QUEUED','RUNNING') AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY created_at LIMIT 1`,
    );
    if (rows.rows[0])
      await executeReplay(db, rows.rows[0].id, { signal: controller.signal });
  })()
    .catch(() => log.warn('Replay job failed; durable run contains the error'))
    .finally(() => {
      busy = null;
    });
  await busy;
}
const timer = setInterval(() => void poll(), 1000);
void poll();
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health/live') {
    res.end(
      JSON.stringify({
        status: 'alive',
        service: 'worker',
        phase: 6,
        capabilities: ['historical_replay'],
        busy: !!busy,
      }),
    );
    return;
  }
  if (req.url === '/health/ready') {
    let ready = !controller.signal.aborted;
    try {
      await pool.query('SELECT id FROM replay_runs LIMIT 0');
    } catch {
      ready = false;
    }
    res.statusCode = ready ? 200 : 503;
    res.end(
      JSON.stringify({
        status: ready ? 'ready' : 'unavailable',
        acceptsNewEntries: false,
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'NOT_FOUND' }));
}).listen(config.WORKER_HEALTH_PORT, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    if (controller.signal.aborted) return;
    controller.abort();
    clearInterval(timer);
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      await busy;
      await pool.end();
      clearTimeout(timeout);
      process.exit(0);
    });
  });
