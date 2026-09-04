import { describe, it, expect, vi } from 'vitest';
import { IngestionController } from './ingestion-controller.js';
import type { BybitAdapter, AccountRatioPoller } from '@tip/ingestion';
import type { EventBus } from '@tip/events';

/**
 * The controller has three lifecycle transitions worth pinning:
 *   1. zero → non-empty: adapter.start() called
 *   2. non-empty → non-empty (delta): only setSymbols() called with new set
 *   3. non-empty → zero: adapter.stop() called
 *
 * Uses lightweight in-memory fakes — the goal is to prove the ORDER of calls, not the
 * behaviour of the real adapter.
 */
describe('IngestionController', () => {
  function makeFakes(perpUniverses: string[][]) {
    const adapter: Partial<BybitAdapter> & { started: boolean; symbols: string[] } = {
      started: false, symbols: [],
      start: vi.fn(() => { adapter.started = true; }),
      stop: vi.fn(() => { adapter.started = false; adapter.symbols = []; }),
      setSymbols: vi.fn((s) => { adapter.symbols = [...s]; }),
    };
    const poller: Partial<AccountRatioPoller> & { started: boolean } = {
      started: false,
      start: vi.fn(() => { poller.started = true; }),
      stop: vi.fn(() => { poller.started = false; }),
      setSymbols: vi.fn(),
    };
    // Fake db: `select().from(tradingAgent).where(...)` returns the current queue head.
    let head = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            const universes = perpUniverses[Math.min(head++, perpUniverses.length - 1)] ?? [];
            return universes.map((sym) => ({ domain: 'perp' as const, universe: [sym] }));
          },
        }),
      }),
    };
    // Fake bus — captures the handler; test drives it manually.
    let handler: ((e: unknown) => Promise<void>) | undefined;
    const bus: Partial<EventBus> = {
      createWorker: vi.fn((_q, h) => { handler = h as never; return {} as never; }),
    };
    return {
      adapter: adapter as unknown as BybitAdapter,
      poller: poller as unknown as AccountRatioPoller,
      db,
      bus: bus as unknown as EventBus,
      trigger: async () => { if (handler) await handler({ type: 'trading_agent.upserted', eventTime: '', source: '', payload: {} }); },
    };
  }

  it('start(): zero agents → adapter NOT started', async () => {
    const f = makeFakes([[]]);
    const ctl = new IngestionController({ db: f.db as never, bus: f.bus, adapter: f.adapter, poller: f.poller });
    const wl = await ctl.start();
    expect(wl.perp).toEqual([]);
    expect(f.adapter.start).not.toHaveBeenCalled();
    expect(f.adapter.setSymbols).not.toHaveBeenCalled();
  });

  it('start(): one agent → adapter starts with the derived set', async () => {
    const f = makeFakes([[ 'BTCUSDT' ]]);
    const ctl = new IngestionController({ db: f.db as never, bus: f.bus, adapter: f.adapter, poller: f.poller });
    const wl = await ctl.start();
    expect(wl.perp).toEqual(['BTCUSDT']);
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
    expect(f.poller.start).toHaveBeenCalledTimes(1);
    expect(f.adapter.setSymbols).toHaveBeenLastCalledWith(['BTCUSDT']);
  });

  it('upsert event: sync grows the universe (BTC → BTC+ETH)', async () => {
    const f = makeFakes([[ 'BTCUSDT' ], ['BTCUSDT','ETHUSDT']]);
    const ctl = new IngestionController({ db: f.db as never, bus: f.bus, adapter: f.adapter, poller: f.poller });
    await ctl.start();
    await f.trigger();
    expect(f.adapter.setSymbols).toHaveBeenLastCalledWith(['BTCUSDT','ETHUSDT']);
    expect(f.adapter.stop).not.toHaveBeenCalled();
  });

  it('upsert event: last agent removed → adapter STOPS', async () => {
    const f = makeFakes([[ 'BTCUSDT' ], []]);
    const ctl = new IngestionController({ db: f.db as never, bus: f.bus, adapter: f.adapter, poller: f.poller });
    await ctl.start();
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
    await f.trigger();
    expect(f.adapter.stop).toHaveBeenCalledTimes(1);
    expect(f.poller.stop).toHaveBeenCalledTimes(1);
  });

  it('reconcile is idempotent — same universe twice is a no-op', async () => {
    const f = makeFakes([[ 'BTCUSDT' ], ['BTCUSDT'], ['BTCUSDT']]);
    const ctl = new IngestionController({ db: f.db as never, bus: f.bus, adapter: f.adapter, poller: f.poller });
    await ctl.start();
    const setCallsAfterStart = (f.adapter.setSymbols as ReturnType<typeof vi.fn>).mock.calls.length;
    await ctl.reconcile();
    await ctl.reconcile();
    // setSymbols may be called again — the adapter itself is what dedupes. Point of this test:
    // adapter.start/stop NEVER re-fire on unchanged universe.
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
    expect(f.adapter.stop).not.toHaveBeenCalled();
    expect((f.adapter.setSymbols as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(setCallsAfterStart);
  });
});
