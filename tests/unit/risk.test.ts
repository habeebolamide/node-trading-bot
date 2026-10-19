import { it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { sizeOrder } from '../../packages/risk/src/sizing.js';
import { fixtureInstrument } from '../fixtures/market.js';
const now = Date.UTC(2026, 9, 19, 12, 17);
const base = {
  equity: '20',
  entry: '100',
  stop: '99',
  target: '110',
  side: 'LONG' as const,
  profile: 'CONSERVATIVE' as const,
  instrument: fixtureInstrument(undefined, now),
  now,
};
it('sizes stop loss plus costs with decimal arithmetic, rounds down and chooses lowest sufficient leverage', () => {
  const a = sizeOrder(base);
  expect(a.quantity).toBe('0.075');
  expect(a.leverage).toBe(4);
  expect(new Decimal(a.stopExposure).lte('.1')).toBe(true);
  expect(new Decimal(a.margin).lte('2')).toBe(true);
});
it('rejects minima rather than increasing size; rejects expired specs and invalid price steps', () => {
  expect(() => sizeOrder({ ...base, equity: '1' })).toThrow(
    'MIN_ORDER_NOT_MET',
  );
  expect(() => sizeOrder({ ...base, now: now + 3600000 })).toThrow(
    'INSTRUMENT_STALE',
  );
  expect(() => sizeOrder({ ...base, stop: '99.001' })).toThrow(
    'PRICE_TICK_NOT_MET',
  );
});
it.each(['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'] as const)(
  'caps leverage and risk for %s across equity and stop distances',
  (profile) => {
    for (const equity of ['20', '100', '500'])
      for (const stop of ['99.99', '99', '90', '50']) {
        const a = sizeOrder({
          ...base,
          equity,
          stop,
          profile,
          instrument: {
            ...base.instrument,
            minNotional: '.01',
            minQuantity: '.000001',
            quantityStep: '.000001',
          },
        });
        const p = a.policy.profiles[profile];
        expect(a.leverage).toBeLessThanOrEqual(p.leverage);
        expect(
          new Decimal(a.stopExposure).lte(new Decimal(equity).mul(p.loss)),
        ).toBe(true);
        expect(
          new Decimal(a.margin).lte(new Decimal(equity).mul(p.margin)),
        ).toBe(true);
        expect(
          new Decimal(a.quantity).mod(a.instrument.quantityStep).isZero(),
        ).toBe(true);
      }
  },
);
it('does not enlarge quantity when instrument permits more leverage', () => {
  expect(sizeOrder(base).quantity).toBe(
    sizeOrder({
      ...base,
      instrument: { ...base.instrument, maxLeverage: '1000' },
    }).quantity,
  );
});
it('uses unleveraged long-only spot positions', () => {
  const instrument = {
    ...base.instrument,
    minNotional: '1',
    market: { ...base.instrument.market, marketType: 'SPOT' as const },
  };
  expect(sizeOrder({ ...base, instrument }).leverage).toBe(1);
  expect(() =>
    sizeOrder({
      ...base,
      instrument,
      side: 'SHORT',
      stop: '101',
      target: '90',
    }),
  ).toThrow('SPOT_SHORT_UNSUPPORTED');
});
it('includes tick rounding in risk and margin sizing even for coarse instruments', () => {
  const a = sizeOrder({
    ...base,
    equity: '100',
    entry: '10',
    stop: '9',
    target: '15',
    instrument: {
      ...base.instrument,
      tickSize: '1',
      minNotional: '.01',
      minQuantity: '.001',
    },
  });
  expect(new Decimal(a.stopExposure).lte('.5')).toBe(true);
  expect(new Decimal(a.notional).gt(new Decimal(a.quantity).mul('10'))).toBe(
    true,
  );
  expect(new Decimal(a.margin).lte('10')).toBe(true);
});
it('scales future risk with independent realized equity and validates versioned policy overrides', () => {
  const before = sizeOrder({ ...base, equity: '20' }),
    after = sizeOrder({ ...base, equity: '19.5' }),
    profit = sizeOrder({ ...base, equity: '21' });
  expect(new Decimal(after.quantity).lt(before.quantity)).toBe(true);
  expect(new Decimal(profit.quantity).gt(before.quantity)).toBe(true);
  expect(() =>
    sizeOrder(base, { ...before.policy, accountMargin: '.5' }),
  ).toThrow('ceiling');
  expect(() =>
    sizeOrder(base, { ...before.policy, costRate: '.0001' }),
  ).toThrow('Cost buffer');
});
it('rejects non-finite financial state and invalid instrument quanta', () => {
  expect(() => sizeOrder({ ...base, equity: 'NaN' })).toThrow(
    'INVALID_RISK_LEVELS',
  );
  expect(() =>
    sizeOrder({
      ...base,
      instrument: { ...base.instrument, quantityStep: '0' },
    }),
  ).toThrow('INVALID_INSTRUMENT_CONSTRAINTS');
});
