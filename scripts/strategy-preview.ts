import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { configFromEnv, marketSchema } from '../packages/core/src/index.js';
import { connectDatabase } from '../packages/database/src/index.js';
import { PostgresCandleRepository } from '../packages/database/src/market-data.js';
import { researchCatalog } from '../packages/strategies/src/catalog.js';
import { preview } from '../packages/strategies/src/engine.js';
import { requiredHistory } from '../packages/market-data/src/indicators.js';
import {
  durations,
  type Timeframe,
} from '../packages/market-data/src/contracts.js';
const { values } = parseArgs({
  options: {
    strategy: { type: 'string', default: 'trend-following' },
    base: { type: 'string', default: 'BTC' },
    quote: { type: 'string', default: 'USDT' },
    type: { type: 'string', default: 'LINEAR_PERPETUAL' },
  },
});
const entry = researchCatalog().find(
  (e) => e.definition.id === values.strategy,
);
if (!entry) throw Error('Unknown research strategy');
const market = marketSchema.parse({
  exchange: 'bybit',
  marketType: values.type,
  baseAsset: values.base,
  quoteAsset: values.quote,
});
const definition = entry.definition;
if (definition.requirements.trigger !== 'CANDLE_CLOSE')
  throw Error('This CLI previews closed-candle research strategies');
const decisionTime = Date.now(),
  cutoff =
    Math.floor(
      decisionTime / durations[definition.requirements.primaryTimeframe],
    ) * durations[definition.requirements.primaryTimeframe];
const { db, pool } = connectDatabase(configFromEnv().DATABASE_URL),
  repo = new PostgresCandleRepository(db);
try {
  const candles: Parameters<typeof preview>[1]['candles'] = {};
  const counts = requiredHistory({
    minClosedCandlesByTimeframe: {
      ...definition.requirements.minClosedCandlesByTimeframe,
    },
    indicators: definition.requirements.indicators.map((i) => ({
      ...i,
      parameters: { ...i.parameters },
    })),
  });
  for (const [frame, count] of Object.entries(counts) as [
    Timeframe,
    number,
  ][]) {
    const end = Math.floor(cutoff / durations[frame]) * durations[frame];
    candles[frame] = await repo.read(
      `${market.exchange}:${market.marketType}:${market.baseAsset}/${market.quoteAsset}`,
      frame,
      end - count * durations[frame],
      end,
      decisionTime,
    );
  }
  const result = preview(definition, {
    botId: randomUUID(),
    accountId: randomUUID(),
    strategyVersionId: randomUUID(),
    configVersion: 1,
    codeHash: entry.codeHash,
    market,
    trigger: {
      type: 'CANDLE_CLOSE',
      timeframe: definition.requirements.primaryTimeframe,
      eventTime: cutoff,
      observedAt: decisionTime,
    },
    dataHealthy: true,
    tradingState: 'IDLE',
    candles,
  });
  console.log(
    JSON.stringify(
      {
        mode: 'OFFLINE_RESEARCH_PREVIEW',
        persisted: false,
        executionEnabled: false,
        decision: result.snapshot.decision,
        dataQuality: result.snapshot.context.dataQuality,
        strategy: result.snapshot.strategy,
        indicators: result.snapshot.context.indicators,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
