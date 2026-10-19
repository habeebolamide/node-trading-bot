import { createServer } from 'node:http';
import { RuntimeSupervisor } from './supervisor.js';
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
const supervisor = new RuntimeSupervisor(db, service, log);
const runtimeTimer = setInterval(
  () => void supervisor.poll().catch(() => log.warn('runtime poll failed')),
  1000,
);
void supervisor.poll().catch(() => log.warn('runtime startup poll failed'));
const leaseTimer = setInterval(
  () =>
    void supervisor
      .renew()
      .catch(() => log.warn('runtime lease renewal failed')),
  5000,
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
        phase: 6,
        capabilities: [
          'public_market_data',
          'paper_execution',
          'risk_and_capital',
        ],
        runtime: supervisor.health(),
        acceptsNewEntries: !stopping,
      }),
    );
    return;
  }
  if (req.url === '/health/ready') {
    let ready = !stopping;
    try {
      await pool.query('select trade_id from paper_reservations limit 0');
    } catch {
      ready = false;
    }
    res.statusCode = ready ? 200 : 503;
    res.end(
      JSON.stringify({
        status: ready ? 'ready' : 'stopping',
        reason:
          'PAPER only; each entry additionally requires healthy market data and atomic risk approval',
        runtime: supervisor.health(),
        marketData: service.allHealth(),
        acceptsNewEntries: !stopping,
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
    clearInterval(runtimeTimer);
    clearInterval(leaseTimer);
    const closing = supervisor.close();
    service.close();
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      await closing;
      await service.drain();
      await pool.end();
      clearTimeout(timeout);
      process.exit(0);
    });
  });
