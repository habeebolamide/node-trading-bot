import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import { createDb, closeDb, type Db } from '@tip/database';
import type { EventBus } from '@tip/events';
import { createApp } from './app.js';
import { clearBackfillJobsForTests } from './backfill.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('backfill routes (data-foundation UI)', () => {
  let db: Db;
  let app: Express;

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const fakeRedis = { ping: vi.fn(async () => 'PONG') } as unknown as Redis;
    const fakeBus = { publish: vi.fn(async () => ({ id: 'e' })) } as unknown as EventBus;
    app = createApp({ db, redis: fakeRedis, bus: fakeBus, webhookSecret: undefined });
  });
  beforeEach(() => clearBackfillJobsForTests());
  afterAll(async () => { if (db) await closeDb(db); });

  it('GET /api/backfill/status returns per-symbol coverage for every default perp symbol', async () => {
    const r = await request(app).get('/api/backfill/status');
    expect(r.status).toBe(200);
    const rows = r.body.symbols as { symbol: string; perTf: unknown[] }[];
    expect(rows.length).toBeGreaterThanOrEqual(3); // BTC/ETH/SOL default
    for (const s of rows) {
      expect(s.perTf.length).toBe(6); // 1m,5m,15m,1h,4h,1d
      expect(s).toHaveProperty('funding');
      expect(s).toHaveProperty('openInterest');
    }
  });

  it('GET /api/backfill/:symbol/status returns coverage for one symbol', async () => {
    const r = await request(app).get('/api/backfill/BTCUSDT/status');
    expect(r.status).toBe(200);
    expect(r.body.symbol).toBe('BTCUSDT');
    expect(Array.isArray(r.body.perTf)).toBe(true);
    expect(r.body.job).toBeNull(); // no run for this test's registry
  });

  it('POST /api/backfill/:symbol/run rejects an invalid symbol → 400', async () => {
    const r = await request(app).post('/api/backfill/not_a_symbol/run').send({});
    expect(r.status).toBe(400);
  });
});
