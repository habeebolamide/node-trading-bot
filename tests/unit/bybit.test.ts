import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { BybitRest } from '../../packages/market-data/src/rest.js';
import { BybitPublicFeed } from '../../packages/market-data/src/feed.js';
import type { FeedEvent } from '../../packages/market-data/src/contracts.js';
import { VirtualClock, fixtureInstrument } from '../fixtures/market.js';
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected event did not arrive');
}
describe('Bybit public protocol', () => {
  it('paginates reverse native candles, filters incomplete data and verifies instrument identity', async () => {
    const clock = new VirtualClock(1200000),
      instrument = fixtureInstrument(undefined, clock.time),
      urls: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const u = new URL(String(input));
      urls.push(u);
      if (u.pathname.endsWith('instruments-info'))
        return Response.json({
          retCode: 0,
          retMsg: 'OK',
          time: clock.time,
          result: {
            category: 'linear',
            list: [
              {
                symbol: 'BTCUSDT',
                baseCoin: 'BTC',
                quoteCoin: 'USDT',
                status: 'Trading',
                contractType: 'LinearPerpetual',
                priceFilter: { tickSize: '0.1' },
                lotSizeFilter: {
                  qtyStep: '0.001',
                  minOrderQty: '0.001',
                  minNotionalValue: '5',
                },
                leverageFilter: { maxLeverage: '100' },
              },
            ],
          },
        });
      const end = Number(u.searchParams.get('end')),
        all = [0, 300000, 600000, 900000, 1200000];
      const list = all
        .filter((t) => t <= end)
        .reverse()
        .slice(0, 2)
        .map((t) => [String(t), '100', '102', '99', '101', '10', '1000']);
      return Response.json({
        retCode: 0,
        retMsg: 'OK',
        time: clock.time,
        result: { category: 'linear', symbol: 'BTCUSDT', list },
      });
    };
    const rest = new BybitRest(fetcher, clock, 'https://fixture.test', 2);
    expect((await rest.instrument(instrument.market)).quantityStep).toBe(
      '0.001',
    );
    const bars = await rest.candles(instrument, '5m', 0, 1500000, clock.time);
    expect(bars.map((c) => c.openTime)).toEqual([0, 300000, 600000, 900000]);
    expect(
      urls
        .filter((u) => u.pathname.endsWith('kline'))
        .map((u) => u.searchParams.get('end')),
    ).toEqual(['1499999', '899999', '299999']);
    expect(urls.every((u) => !u.searchParams.has('api_key'))).toBe(true);
  });
  it('returns missing ranges honestly and rejects malformed/mismatched responses', async () => {
    const clock = new VirtualClock(),
      instrument = fixtureInstrument(undefined, clock.time);
    const empty = new BybitRest(
      async () =>
        Response.json({
          retCode: 0,
          retMsg: 'OK',
          time: clock.time,
          result: { category: 'linear', symbol: 'BTCUSDT', list: [] },
        }),
      clock,
    );
    expect(
      await empty.candles(instrument, '5m', 0, 300000, clock.time),
    ).toEqual([]);
    const bad = new BybitRest(
      async () =>
        Response.json({
          retCode: 0,
          retMsg: 'OK',
          time: clock.time,
          result: { category: 'linear', symbol: 'ETHUSDT', list: [] },
        }),
      clock,
    );
    await expect(
      bad.candles(instrument, '5m', 0, 300000, clock.time),
    ).rejects.toThrow();
  });
  it('uses one shared WebSocket topic, confirms subscription, filters open candles and reconnects', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address !== 'object' || !address)
      throw Error('No socket address');
    let connections = 0,
      subscriptions = 0;
    const events: FeedEvent[] = [],
      second: FeedEvent[] = [];
    server.on('connection', (socket) => {
      connections++;
      socket.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.op === 'subscribe') {
          subscriptions++;
          socket.send(
            JSON.stringify({
              op: 'subscribe',
              success: true,
              req_id: m.req_id,
            }),
          );
        }
        if (m.op === 'unsubscribe')
          socket.send(JSON.stringify({ op: 'unsubscribe', success: true }));
        if (m.op === 'ping') socket.send(JSON.stringify({ op: 'pong' }));
      });
    });
    const feed = new BybitPublicFeed(
        undefined,
        undefined,
        `ws://127.0.0.1:${address.port}`,
        1000,
        20,
      ),
      instrument = fixtureInstrument(undefined, Date.now());
    try {
      const a = feed.subscribe(instrument, ['5m'], (e) => events.push(e));
      const b = feed.subscribe(instrument, ['5m'], (e) => second.push(e));
      await until(
        () =>
          events.some((e) => e.kind === 'STATUS' && e.state === 'CONNECTED') &&
          second.some((e) => e.kind === 'STATUS' && e.state === 'CONNECTED'),
      );
      expect(connections).toBe(1);
      expect(subscriptions).toBe(1);
      const extra: FeedEvent[] = [];
      const removeExtra = feed.subscribe(instrument, ['1h'], (e) =>
        extra.push(e),
      );
      await until(() =>
        extra.some((e) => e.kind === 'STATUS' && e.state === 'CONNECTED'),
      );
      removeExtra();
      await new Promise((r) => setTimeout(r, 20));
      expect(connections).toBe(1);
      expect(
        events.some((e) => e.kind === 'STATUS' && e.state === 'ERROR'),
      ).toBe(false);

      const socket = [...server.clients][0]!,
        now = Date.now(),
        open = Math.floor(now / 300000) * 300000 - 300000;
      const candle = {
        start: open,
        end: open + 299999,
        interval: '5',
        open: '100',
        high: '102',
        low: '99',
        close: '101',
        volume: '10',
        confirm: false,
      };
      socket.send(
        JSON.stringify({ topic: 'kline.5.BTCUSDT', ts: now, data: [candle] }),
      );
      socket.send(
        JSON.stringify({
          topic: 'kline.5.BTCUSDT',
          ts: now,
          data: [{ ...candle, confirm: true }],
        }),
      );
      socket.send(
        JSON.stringify({
          topic: 'publicTrade.BTCUSDT',
          ts: now,
          data: [
            { T: now, s: 'BTCUSDT', S: 'Buy', v: '1', p: '100', i: 'trade-1' },
            { T: now, s: 'BTCUSDT', S: 'Sell', v: '1', p: '101', i: 'trade-2' },
          ],
        }),
      );
      await until(() => events.filter((e) => e.kind === 'PRICE').length === 2);
      expect(events.filter((e) => e.kind === 'CANDLE')).toHaveLength(1);
      a();
      socket.close();
      await until(
        () =>
          connections === 2 &&
          second.filter((e) => e.kind === 'STATUS' && e.state === 'CONNECTED')
            .length === 2,
      );
      expect(
        second.some((e) => e.kind === 'STATUS' && e.state === 'DISCONNECTED'),
      ).toBe(true);
      b();
    } finally {
      feed.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
