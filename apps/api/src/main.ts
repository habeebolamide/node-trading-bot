import { createServer } from 'node:http';
import { getConfig, loadEnv, configureLogger, logFilePathFor } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { createRedis, EventBus } from '@tip/events';
import { HeliusRestClient, HeliusWebhookAdmin } from '@tip/ingestion';
import { HeliusSubscriptionManager, Watchlist } from '@tip/watchlist';
import { createApp, type ApiDeps } from './app.js';
import { attachAgentRoom } from './agent-room.js';

/** Boot the API: validate env, wire real connections, listen, wire shutdown. */
async function main(): Promise<void> {
  loadEnv(); // hydrate process.env from repo-root .env (no-op in production)
  const config = getConfig(); // validates env; throws FatalError if bad
  // One unified log folder at <repo>/logs/. Every log.* call from anywhere in this process
  // appends to logs/api.log — no more scattered app.log copies under apps/api/logs/.
  configureLogger({ level: 'debug', file: logFilePathFor('api', import.meta.url) });
  const db = getDb();
  const redis = createRedis(config.REDIS_URL);
  const bus = new EventBus(createRedis(config.REDIS_URL)); // bus owns its own connection

  // Watchlist (m3-watchlist) is only enabled when the Helius keys + webhook URL are configured.
  // Missing any of the three → the /wallets endpoints stay unmounted, but the rest of the API works.
  let watchlist: Watchlist | undefined;
  if (config.HELIUS_API_KEY && config.HELIUS_WEBHOOK_SECRET && config.HELIUS_WEBHOOK_URL) {
    const rest = new HeliusRestClient({ apiKey: config.HELIUS_API_KEY });
    const admin = new HeliusWebhookAdmin({ apiKey: config.HELIUS_API_KEY });
    const subscription = new HeliusSubscriptionManager({
      db,
      admin,
      config: { webhookURL: config.HELIUS_WEBHOOK_URL, authHeader: config.HELIUS_WEBHOOK_SECRET },
      // eslint-disable-next-line no-console
      log: (msg, meta) => console.log(`[helius-sub] ${msg}`, meta ?? ''),
    });
    watchlist = new Watchlist({
      db,
      rest,
      subscription,
      // eslint-disable-next-line no-console
      log: (msg, meta) => console.log(`[watchlist] ${msg}`, meta ?? ''),
    });
    // eslint-disable-next-line no-console
    console.log('[api] watchlist enabled (/wallets endpoints mounted)');
  } else {
    // eslint-disable-next-line no-console
    console.log('[api] watchlist disabled — set HELIUS_API_KEY + HELIUS_WEBHOOK_SECRET + HELIUS_WEBHOOK_URL to enable');
  }

  const deps: ApiDeps = {
    db,
    redis,
    bus,
    webhookSecret: config.HELIUS_WEBHOOK_SECRET,
    bybitTestnet: config.BYBIT_TESTNET,
    ...(config.DEEPSEEK_API_KEY ? { deepseekApiKey: config.DEEPSEEK_API_KEY } : {}),
    startedAt: Date.now(),
    ...(watchlist ? { watchlist } : {}),
  };
  const app = createApp(deps);

  const server = createServer(app);

  // §27 Agent Room — WS fan-out for the dashboard. Read-only; drops on client backpressure.
  const agentRoom = attachAgentRoom({ server, redis });
  // eslint-disable-next-line no-console
  console.log('[api] agent-room WS mounted at /ws/agent-room');

  await new Promise<void>((resolve) => server.listen(config.API_PORT, resolve));
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${config.API_PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // a second signal (tsx watch can send SIGTERM then SIGKILL) is a no-op
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[api] ${signal} — shutting down`);
    // Hard deadline: if graceful cleanup stalls, exit anyway so the port frees for a `tsx watch`
    // restart. Without this, a hung server.close() (below) left :PORT bound → EADDRINUSE on the
    // next reload. 3s is ample for a clean drain; the unref() keeps the timer from holding the loop.
    const deadline = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn('[api] shutdown deadline hit — forcing exit');
      process.exit(0);
    }, 3_000);
    deadline.unref();
    await agentRoom.close();
    // Stop accepting new connections, THEN force-drop lingering ones (WebSocket upgrades +
    // keep-alive sockets keep server.close() from ever completing otherwise — the real cause of
    // the EADDRINUSE-on-restart loop). closeAllConnections is Node 18.2+.
    server.close();
    server.closeAllConnections?.();
    await bus.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
    clearTimeout(deadline);
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
