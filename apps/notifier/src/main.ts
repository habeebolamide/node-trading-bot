import { createServer } from 'node:http';
import { z } from 'zod';
import { connectDatabase } from '../../../packages/database/src/index.js';
import { createLogger } from '../../../packages/core/src/index.js';
import {
  projectNotifications,
  deliverOne,
  expireFinalAttempts,
  telegramSender,
} from '../../../packages/notifications/src/service.js';
const env = z
  .object({
    DATABASE_URL: z.string().url(),
    NOTIFIER_HEALTH_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(3003),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
  })
  .parse(process.env);
const { pool } = connectDatabase(env.DATABASE_URL);
// A dedicated small pool bounds notification pressure on the trading database.
pool.options.max = 2;
const log = createLogger('notifier');
const sender = env.TELEGRAM_BOT_TOKEN
  ? telegramSender(env.TELEGRAM_BOT_TOKEN)
  : null;
let busy: Promise<void> | null = null,
  stopping = false,
  lastSuccess = 0;
function poll() {
  if (busy || stopping) return;
  busy = (async () => {
    await projectNotifications(pool);
    await expireFinalAttempts(pool);
    if (sender) await deliverOne(pool, sender);
    await pool.query(
      `INSERT INTO notification_worker_health(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET observed_at=now()`,
      [sender ? 'delivery' : 'delivery-unconfigured'],
    );
    lastSuccess = Date.now();
  })()
    .catch(() => log.warn('Notification poll failed; durable work retained'))
    .finally(() => {
      busy = null;
    });
}
const timer = setInterval(poll, 1000);
poll();
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (!['/health/live', '/health/ready'].includes(req.url ?? '')) {
    res.statusCode = 404;
    res.end('{}');
    return;
  }
  const ready = !stopping && Date.now() - lastSuccess < 15000;
  res.statusCode = req.url === '/health/ready' && !ready ? 503 : 200;
  res.end(
    JSON.stringify({
      service: 'notifier',
      status: ready ? 'ready' : 'degraded',
      telegramConfigured: !!sender,
      lastSuccess: lastSuccess || null,
    }),
  );
}).listen(env.NOTIFIER_HEALTH_PORT, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(async () => {
      await busy;
      await pool.end();
      clearTimeout(deadline);
      process.exit(0);
    });
  });
