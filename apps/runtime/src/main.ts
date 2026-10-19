import { createServer } from 'node:http';
import {
  configFromEnv,
  createLogger,
} from '../../../packages/core/src/index.js';
import { connectDatabase } from '../../../packages/database/src/index.js';
import { PostgresCandleRepository } from '../../../packages/database/src/market-data.js';
import {
  MarketDataService,
  BybitMarketDataProvider,
} from '../../../packages/market-data/src/index.js';
import { marketDataConfig } from '../../../packages/market-data/src/config.js';
const config = configFromEnv(),
  marketConfig = marketDataConfig(),
  log = createLogger('runtime', config.LOG_LEVEL);
const { pool, db } = connectDatabase(config.DATABASE_URL);
const service = new MarketDataService(
  new BybitMarketDataProvider(),
  new PostgresCandleRepository(db),
  undefined,
  marketConfig.heartbeatMaxAgeMs,
);
let stopping = false,
  busy = false;
async function repair() {
  if (busy || stopping) return;
  busy = true;
  try {
    for (const entry of marketConfig.watchlist) {
      if (stopping) break;
      try {
        await service.seed(entry.market, {
          minClosedCandlesByTimeframe: entry.minClosedCandlesByTimeframe,
        });
      } catch {
        log.warn(
          { market: entry.market, correlationId: crypto.randomUUID() },
          'market data unavailable; entries remain disabled',
        );
      }
    }
  } finally {
    busy = false;
  }
}
const timer = setInterval(() => void repair(), marketConfig.repairIntervalMs);
void repair();
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health/live') {
    res.end(
      JSON.stringify({
        status: 'alive',
        service: 'runtime',
        phase: 2,
        capabilities: ['public_market_data'],
        acceptsNewEntries: false,
      }),
    );
    return;
  }
  if (req.url === '/health/ready') {
    res.statusCode = 503;
    res.end(
      JSON.stringify({
        status: 'not_ready',
        reason: 'Strategy and trading runtime arrive in later phases',
        marketData: service.allHealth(),
        acceptsNewEntries: false,
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'NOT_FOUND' }));
}).listen(config.RUNTIME_HEALTH_PORT, '127.0.0.1', () =>
  log.info({ port: config.RUNTIME_HEALTH_PORT }, 'market runtime listening'),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    service.close();
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      await service.drain();
      await pool.end();
      clearTimeout(timeout);
      process.exit(0);
    });
  });
