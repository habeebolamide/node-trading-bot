import {
  candleSchema,
  durations,
  type Timeframe,
} from '../../market-data/src/contracts.js';
import { FinancialDecimal as D } from '../../core/src/decimal.js';
import { money } from '../../risk/src/sizing.js';
import { seededFraction } from './contracts.js';
// Illustrative seed histories only; never presented as downloaded exchange evidence.
export function seededCandles(
  seed: number,
  marketKey: string,
  timeframe: Timeframe,
  start: number,
  count: number,
) {
  const duration = durations[timeframe];
  if (
    start % duration ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 100000
  )
    throw Error('Invalid seed range');
  let price = new D(100);
  return Array.from({ length: count }, (_, n) => {
    const open = price;
    price = D.max(
      1,
      open.plus(
        new D(seededFraction(seed, `${marketKey}:${timeframe}:${n}`))
          .minus('.45')
          .mul('.2'),
      ),
    );
    const time = start + n * duration;
    return candleSchema.parse({
      marketKey,
      timeframe,
      openTime: time,
      closeTime: time + duration,
      open: money(open),
      close: money(price),
      high: money(D.max(open, price).plus('.1')),
      low: money(D.min(open, price).minus('.1')),
      volume: '100',
      isClosed: true,
      source: 'FIXTURE',
      observedAt: time + duration,
      availableAt: time + duration,
    });
  });
}
