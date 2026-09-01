import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { Db } from '@tip/database';
import type { EventBus } from '@tip/events';
import type { Redis } from 'ioredis';
import type { Watchlist, WatchedRow, AddResult } from '@tip/watchlist';
import { ValidationError } from '@tip/domain';
import { createApp } from './app.js';

function stubWatchlist(over: Partial<Record<keyof Watchlist, unknown>> = {}): Watchlist {
  const addResult: AddResult = { address: 'W', status: 'rated', score: 82, tradeCount: 40, resurrected: false, backfillMs: 100 };
  return {
    add: vi.fn(async () => addResult),
    remove: vi.fn(async () => ({ removed: true })),
    list: vi.fn(async () => [] as WatchedRow[]),
    isWatched: vi.fn(async () => false),
    ...over,
  } as unknown as Watchlist;
}

function deps(watchlist: Watchlist) {
  return {
    db: { execute: vi.fn().mockResolvedValue([]) } as unknown as Db,
    redis: { ping: vi.fn().mockResolvedValue('PONG') } as unknown as Redis,
    bus: { publish: vi.fn().mockResolvedValue({ id: 'e' }) } as unknown as EventBus,
    webhookSecret: 'topsecret',
    watchlist,
  };
}

describe('POST /wallets', () => {
  it('400 when body has no address', async () => {
    const res = await request(createApp(deps(stubWatchlist()))).post('/wallets').send({});
    expect(res.status).toBe(400);
  });

  it('201 on new add — returns the rating outcome', async () => {
    const wl = stubWatchlist();
    const res = await request(createApp(deps(wl))).post('/wallets').send({ address: 'W1', note: 'trader' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ address: 'W', status: 'rated', score: 82, resurrected: false });
    expect(wl.add).toHaveBeenCalledWith('W1', 'trader');
  });

  it('200 on resurrect (previously soft-deleted)', async () => {
    const wl = stubWatchlist({
      add: vi.fn(async () => ({ address: 'W', status: 'rated', score: 70, tradeCount: 20, resurrected: true, backfillMs: 100 })),
    });
    const res = await request(createApp(deps(wl))).post('/wallets').send({ address: 'W' });
    expect(res.status).toBe(200);
  });

  it('400 when Watchlist throws ValidationError', async () => {
    const wl = stubWatchlist({ add: vi.fn(async () => { throw new ValidationError('bad'); }) });
    const res = await request(createApp(deps(wl))).post('/wallets').send({ address: 'X' });
    expect(res.status).toBe(400);
  });
});

describe('GET /wallets', () => {
  it('returns the active list', async () => {
    const rows: WatchedRow[] = [
      { address: 'A', note: null, watchedAt: new Date('2026-01-01'), status: 'rated', score: 80, tradeCount: 30, lastScoredAt: new Date('2026-01-02') },
      { address: 'B', note: 'x', watchedAt: new Date('2026-01-01'), status: 'unrated', score: null, tradeCount: 3, lastScoredAt: null },
    ];
    const wl = stubWatchlist({ list: vi.fn(async () => rows) });
    const res = await request(createApp(deps(wl))).get('/wallets');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.wallets).toHaveLength(2);
  });
});

describe('DELETE /wallets/:address', () => {
  it('204 on successful remove', async () => {
    const wl = stubWatchlist({ remove: vi.fn(async () => ({ removed: true })) });
    const res = await request(createApp(deps(wl))).delete('/wallets/W1');
    expect(res.status).toBe(204);
    expect(wl.remove).toHaveBeenCalledWith('W1');
  });

  it('404 when address is not actively watched', async () => {
    const wl = stubWatchlist({ remove: vi.fn(async () => ({ removed: false })) });
    const res = await request(createApp(deps(wl))).delete('/wallets/Unknown');
    expect(res.status).toBe(404);
  });
});

describe('wallets endpoints disabled', () => {
  it('when no Watchlist is provided, POST /wallets is not mounted (404)', async () => {
    const app = createApp({ ...deps(stubWatchlist()), watchlist: undefined });
    const res = await request(app).post('/wallets').send({ address: 'W' });
    expect(res.status).toBe(404);
  });
});
