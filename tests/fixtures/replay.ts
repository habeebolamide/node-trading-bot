import { strategyInput, closeTime } from './strategies.js';
import { fixtureInstrument, market } from './market.js';
import { paperPolicy } from '../../packages/risk/src/sizing.js';
import { marketKey } from '../../packages/core/src/index.js';
import type {
  ReplayInput,
  ReplayEvent,
} from '../../packages/replay/src/contracts.js';
export function replayFixture(): ReplayInput {
  const strategy = strategyInput('trend-long'),
    key = marketKey(market),
    start = closeTime - 1000,
    end = closeTime + 6000;
  const tick = (id: string, offset: number, price: string): ReplayEvent => ({
    kind: 'PRICE',
    marketKey: key,
    tradeId: id,
    eventTime: closeTime + offset,
    observedAt: closeTime + offset,
    price,
    quantity: '100',
    reference: 'LAST',
    side: 'SELL',
    late: false,
  });
  return {
    version: 'replay-v1',
    seed: 42,
    start,
    end,
    equityBaseline: '100',
    bots: [
      {
        key: 'trend',
        market,
        strategy: 'trend-following',
        allocationTargetPercent: '20',
        riskProfile: 'CONSERVATIVE',
      },
    ],
    policy: structuredClone(paperPolicy),
    liquidity: { model: 'FIXED_PARTICIPATION', minimumFactor: 1 },
    dataset: {
      name: 'Illustrative deterministic research fixture',
      version: '1',
      instrumentHistory: 'HISTORICAL',
      fundingCoverage: 'COMPLETE',
      tradeCoverage: 'COMPLETE_ORDERED',
      instruments: [fixtureInstrument(market, start - 1000)],
      candles: Object.values(strategy.candles).flatMap((c) => c!),
      events: [
        { kind: 'CANDLE', candle: strategy.candles['15m']!.at(-1)! },
        tick('entry', 2000, '199.7'),
        {
          kind: 'FUNDING',
          marketKey: key,
          period: closeTime + 2500,
          observedAt: closeTime + 2500,
          rate: '0.0001',
          price: '200',
        },
        tick('take-profit', 3000, '205'),
        tick('exit', 4000, '205'),
        { kind: 'TIMER', observedAt: end },
      ],
    },
  };
}
