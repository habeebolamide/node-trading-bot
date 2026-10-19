import { parseArgs } from 'node:util';
import { z } from 'zod';
import { configFromEnv, marketSchema } from '../packages/core/src/index.js';
import { connectDatabase } from '../packages/database/src/index.js';
import { PostgresCandleRepository } from '../packages/database/src/market-data.js';
import {
  BybitMarketDataProvider,
  MarketDataService,
  timeframeSchema,
} from '../packages/market-data/src/index.js';
const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'BTC' },
    quote: { type: 'string', default: 'USDT' },
    type: { type: 'string', default: 'LINEAR_PERPETUAL' },
    timeframes: { type: 'string', default: '5m,1h' },
    count: { type: 'string', default: '500' },
  },
});
const market = marketSchema.parse({
  exchange: 'bybit',
  marketType: values.type,
  baseAsset: values.base,
  quoteAsset: values.quote,
});
const frames = values
  .timeframes!.split(',')
  .map((f) => timeframeSchema.parse(f));
const count = z.coerce.number().int().min(1).max(10000).parse(values.count);
const { db, pool } = connectDatabase(configFromEnv().DATABASE_URL);
const service = new MarketDataService(
  new BybitMarketDataProvider(),
  new PostgresCandleRepository(db),
);
try {
  const health = await service.seed(market, {
    minClosedCandlesByTimeframe: Object.fromEntries(
      frames.map((f) => [f, count]),
    ),
  });
  console.log(JSON.stringify(health, null, 2));
  if (
    Object.values(health.series).some(
      (s) => !s || s.missing > 0 || s.count < s.required,
    )
  )
    process.exitCode = 1;
} finally {
  service.close();
  await service.drain();
  await pool.end();
}
