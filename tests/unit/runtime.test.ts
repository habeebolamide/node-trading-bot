import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PositionManager } from '../../packages/runtime/src/position-manager.js';
import { trendFollowing } from '../../packages/strategies/src/research.js';
import { market } from '../fixtures/market.js';
import { marketKey } from '../../packages/core/src/index.js';
import type {
  View,
  Action,
  Report,
} from '../../packages/runtime/src/contracts.js';
const manager = new PositionManager(),
  now = 1000000;
function base(): View {
  return {
    botId: randomUUID(),
    accountId: randomUUID(),
    market,
    marketKey: marketKey(market),
    strategyVersionId: randomUUID(),
    configVersion: 1,
    executionMode: 'PAPER',
    operational: 'RUNNING',
    trading: 'IDLE',
    desired: 'RUNNING',
    trade: null,
    actions: [],
    lastPriceTime: 0,
    lastCandleTime: 0,
    lastEvaluationId: null,
    fault: null,
  };
}
function pending() {
  return manager.entry(
    base(),
    {
      action: 'PROPOSE_ENTRY',
      side: 'LONG',
      orderType: 'LIMIT',
      entryPrice: '100',
      stopLoss: '98',
      takeProfit: '104',
      expiresAt: now + 60000,
      reason: 'TREND_CONFIRMED',
    },
    randomUUID(),
    structuredClone(trendFollowing.managementPolicy),
    now,
    1,
  ).view;
}
function report(
  v: View,
  a: Action,
  kind: Report['kind'],
  fields: Partial<Report> = {},
) {
  return manager.report(
    v,
    {
      eventId: randomUUID(),
      botId: v.botId,
      tradeId: v.trade!.id,
      actionId: a.id,
      kind,
      eventTime: now,
      ...fields,
    },
    now + 1,
  ).view;
}
function open() {
  let v = pending();
  v = report(v, v.actions[0]!, 'ENTRY_FILL', { quantity: '1', price: '100' });
  const a = v.actions.find((a) => a.kind === 'PROTECT')!;
  return report(v, a, 'STOP_CONFIRMED', {
    quantity: '1',
    stopPrice: a.stopPrice!,
    revision: a.revision,
  });
}
function price(v: View, value: string, time = now + 1000) {
  return manager.price(v, {
    kind: 'PRICE',
    marketKey: v.marketKey,
    tradeId: randomUUID(),
    eventTime: time,
    observedAt: time,
    price: value,
    quantity: '1',
    side: 'BUY',
    reference: 'LAST',
    late: false,
  });
}
it('separates control state and position state; pause does not close a position', () => {
  const v = open(),
    paused = manager.command(
      v,
      { id: randomUUID(), kind: 'PAUSE', requestedAt: now },
      now,
    ).view;
  expect(paused.operational).toBe('PAUSED');
  expect(paused.trading).toBe('IN_TRADE');
  expect(paused.actions.some((a) => a.kind === 'CLOSE')).toBe(false);
  expect(
    price(paused, '97').actions.filter((a) => a.kind === 'CLOSE'),
  ).toHaveLength(1);
});
it('requests break-even and ATR trailing while keeping the old confirmed stop until acknowledged', () => {
  const v = open(),
    c = price(v, '102.5');
  expect(c.view.trade!.desiredStop).toBe('100.5');
  expect(c.view.trade!.confirmedStop).toBe('98');
  expect(c.actions[0]!.kind).toBe('AMEND_STOP');
  const stillWaiting = price(c.view, '103', now + 2000);
  expect(stillWaiting.actions).toHaveLength(0);
  expect(stillWaiting.view.trade!.confirmedStop).toBe('98');
  expect(stillWaiting.view.trade!.desiredStop).toBe('101');
});
it('never loosens a trailing stop and ignores stale/reordered prices', () => {
  const v = open(),
    up = price(v, '103').view,
    down = price(up, '102.8', now + 2000).view;
  expect(down.trade!.desiredStop).toBe(up.trade!.desiredStop);
  expect(price(down, '97', now + 1000).actions).toHaveLength(0);
});
it('time expiry cancels only the unfilled part of a partially filled entry', () => {
  let v = pending();
  v = report(v, v.actions[0]!, 'ENTRY_FILL', { quantity: '0.4', price: '100' });
  const c = manager.timer(v, now + 60000);
  expect(c.actions.find((a) => a.kind === 'CANCEL_ENTRY')!.quantity).toBe(
    '0.6',
  );
  expect(c.view.trading).toBe('IN_TRADE');
  expect(c.actions.some((a) => a.kind === 'CLOSE')).toBe(false);
});
it('rejects an acknowledgment that does not match submitted protection', () => {
  let v = pending();
  v = report(v, v.actions[0]!, 'ENTRY_FILL', { quantity: '1', price: '100' });
  const action = v.actions.find((a) => a.kind === 'PROTECT')!;
  expect(() =>
    report(v, action, 'STOP_CONFIRMED', {
      quantity: '1',
      stopPrice: '90',
      revision: action.revision,
    }),
  ).toThrow(/mismatch/);
  expect(v.trade!.confirmedStop).toBeNull();
});
it('unknown stop amendments retain known protective threshold monitoring without duplicate closes', () => {
  const c = price(open(), '102.5'),
    amend = c.actions[0]!;
  const unknown = report(c.view, amend, 'UNKNOWN');
  const stop = price(unknown, '97', now + 2000);
  expect(stop.actions.filter((a) => a.kind === 'CLOSE')).toHaveLength(1);
  expect(stop.view.fault).toBe('EXECUTION_RECONCILIATION_REQUIRED');
});
it('signal-only proposals cannot enter the fake execution lifecycle', () => {
  const v = base();
  v.executionMode = 'SIGNAL_ONLY';
  const c = manager.entry(
    v,
    {
      action: 'PROPOSE_ENTRY',
      side: 'LONG',
      orderType: 'MARKET',
      entryPrice: '100',
      stopLoss: '98',
      takeProfit: '104',
      expiresAt: now + 60000,
      reason: 'TREND_CONFIRMED',
    },
    randomUUID(),
    structuredClone(trendFollowing.managementPolicy),
    now,
  );
  expect(c.actions).toHaveLength(0);
  expect(c.view.trading).toBe('IDLE');
});
