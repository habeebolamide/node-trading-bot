import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { Db } from '@tip/database';
import type { EventBus } from '@tip/events';
import type { Redis } from 'ioredis';
import { createApp, type ApiDeps } from './app.js';

function makeDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    db: { execute: vi.fn().mockResolvedValue([]) } as unknown as Db,
    redis: { ping: vi.fn().mockResolvedValue('PONG') } as unknown as Redis,
    bus: { publish: vi.fn().mockResolvedValue({ id: 'evt' }) } as unknown as EventBus,
    webhookSecret: 'topsecret',
    ...over,
  };
}

describe('GET /health', () => {
  it('200 ok when db + redis respond', async () => {
    const res = await request(createApp(makeDeps())).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok' });
  });

  it('503 degraded when db ping fails', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('down')) } as unknown as Db;
    const res = await request(createApp(makeDeps({ db }))).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'fail', redis: 'ok' });
  });
});

describe('POST /webhooks/helius', () => {
  it('401 on wrong secret and does not enqueue', async () => {
    const deps = makeDeps();
    const res = await request(createApp(deps))
      .post('/webhooks/helius')
      .set('authorization', 'wrong')
      .send([{ any: 'payload' }]);
    expect(res.status).toBe(401);
    expect(deps.bus.publish).not.toHaveBeenCalled();
  });

  it('200 and enqueues raw body on correct secret', async () => {
    const deps = makeDeps();
    const res = await request(createApp(deps))
      .post('/webhooks/helius')
      .set('authorization', 'topsecret')
      .send([{ signature: 'abc' }]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(deps.bus.publish).toHaveBeenCalledOnce();
    const [queue, event] = (deps.bus.publish as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(queue).toBe('blockchain-ingestion');
    expect(event.type).toBe('helius.webhook.received');
    expect(event.source).toBe('helius-webhook');
  });

  it('503 when webhook secret is not configured', async () => {
    const res = await request(createApp(makeDeps({ webhookSecret: undefined })))
      .post('/webhooks/helius')
      .set('authorization', 'anything')
      .send({});
    expect(res.status).toBe(503);
  });
});
