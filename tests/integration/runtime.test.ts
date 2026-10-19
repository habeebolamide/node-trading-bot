import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import {
  connectDatabase,
  users,
  accounts,
  tokens,
  runtimeActions,
  runtimeEvents,
  runtimeLeases,
  runtimeCommands,
  tradeLifecycles,
  evaluations,
  bots,
} from '../../packages/database/src/index.js';
import { migrateDatabase } from '../../packages/database/src/migrate.js';
import { registerResearchStrategies } from '../../packages/database/src/strategies.js';
import {
  PostgresRuntimeRepository,
  RuntimeControlRepository,
} from '../../packages/database/src/runtime.js';
import { DurableFakeExecutionAdapter } from '../../packages/database/src/fake-execution.js';
import { PostgresEvaluationRepository } from '../../packages/database/src/evaluations.js';
import { BotRepository, type Actor } from '../../packages/database/src/bots.js';
import { BotRuntime } from '../../packages/runtime/src/bot-runtime.js';
import { PositionManager } from '../../packages/runtime/src/position-manager.js';
import { trendFollowing } from '../../packages/strategies/src/research.js';
import { strategyInput, closeTime } from '../fixtures/strategies.js';
import { market, VirtualClock } from '../fixtures/market.js';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger } from '../../packages/core/src/index.js';
import type {
  Lease,
  Action,
  Report,
  CommandKind,
} from '../../packages/runtime/src/contracts.js';
try {
  loadEnvFile('.env');
} catch {
  /* explicit environment */
}
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Dedicated test DB required');
const { db, pool } = connectDatabase(url),
  store = new PostgresRuntimeRepository(db),
  controls = new RuntimeControlRepository(db),
  botRepo = new BotRepository(db);
let actor: Actor,
  bot: Awaited<ReturnType<BotRepository['create']>>,
  lease: Lease,
  adapter: DurableFakeExecutionAdapter,
  runtime: BotRuntime,
  clock: VirtualClock,
  codeHash: string,
  token: string;
beforeAll(() => migrateDatabase(url));
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query(
    'TRUNCATE audit_events,bot_config_versions,coin_ownership,bots,api_tokens,exchange_accounts,strategy_versions,strategies,app_users CASCADE',
  );
  const [owner] = await db
    .insert(users)
    .values({ email: 'runtime-owner@fixture.local' })
    .returning();
  await db
    .insert(accounts)
    .values({ ownerUserId: owner!.id, name: 'Fake runtime' });
  actor = { userId: owner!.id, role: 'OWNER' };
  token = randomBytes(32).toString('base64url');
  await db.insert(tokens).values({
    userId: owner!.id,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    role: 'OWNER',
    expiresAt: new Date(Date.now() + 60000),
  });
  const registry = await registerResearchStrategies(db),
    version = registry.find((v) => v.slug === 'trend-following')!;
  codeHash = version.codeHash;
  bot = await botRepo.create(
    actor,
    {
      name: 'Runtime fixture',
      market,
      strategyVersionId: version.id,
      executionMode: 'PAPER',
      riskProfile: 'CONSERVATIVE',
      allocationTargetPercent: '20',
    },
    randomUUID(),
  );
  clock = new VirtualClock(closeTime - 900000);
  lease = (await store.acquire(bot.id, randomUUID()))!;
  adapter = new DurableFakeExecutionAdapter(db, {}, clock);
  runtime = new BotRuntime(
    store,
    lease,
    adapter,
    trendFollowing,
    codeHash,
    new PostgresEvaluationRepository(db, lease),
    clock,
  );
});
async function command(kind: CommandKind) {
  const c = await controls.enqueue(
    actor,
    bot.id,
    kind,
    randomUUID(),
    `Fixture ${kind}`,
    randomUUID(),
  );
  return runtime.command(c as never);
}
async function start() {
  await runtime.restore();
  await command('START');
  await runtime.ready(true);
  await runtime.ready(true);
  expect((await store.load(bot.id)).operational).toBe('RUNNING');
}
async function entry() {
  await start();
  clock.time = closeTime + 2000;
  const input = strategyInput('trend-long');
  await runtime.candle(input.trigger, input.candles, true);
  const view = await store.load(bot.id);
  expect(view.trading).toBe('PENDING_ENTRY');
  return view.actions.find((a) => a.kind === 'ENTRY')!;
}
async function append(
  action: Action,
  kind: Report['kind'],
  fields: Partial<Report> = {},
) {
  const report: Report = {
    eventId: randomUUID(),
    actionId: action.id,
    tradeId: action.tradeId,
    botId: bot.id,
    kind,
    eventTime: clock.time,
    ...fields,
  };
  await adapter.append(report);
  await runtime.report(report);
  return report;
}
async function fill() {
  const a = await entry();
  clock.advance(1000);
  await append(a, 'ENTRY_FILL', { quantity: '1', price: '199.8' });
  expect((await store.load(bot.id)).trade?.protectionStatus).toBe('CONFIRMED');
  return a;
}
function tick(price: string, id = randomUUID()) {
  return {
    kind: 'PRICE' as const,
    marketKey: bot.canonicalMarketId,
    tradeId: id,
    eventTime: clock.time,
    observedAt: clock.time,
    price,
    quantity: '1',
    side: 'BUY' as const,
    reference: 'LAST' as const,
    late: false,
  };
}
it('runs the durable golden lifecycle IDLE → PENDING_ENTRY → IN_TRADE → CLOSING → IDLE', async () => {
  await fill();
  expect((await store.load(bot.id)).trading).toBe('IN_TRADE');
  clock.advance(1000);
  await runtime.price(tick('203'));
  expect((await store.load(bot.id)).trading).toBe('CLOSING');
  const close = (await store.load(bot.id)).actions.find(
    (a) => a.kind === 'CLOSE',
  )!;
  await append(close, 'EXIT_FILL', {
    quantity: '1',
    price: '203',
    terminal: true,
  });
  expect((await store.load(bot.id)).trading).toBe('IDLE');
  const [trade] = await db.select().from(tradeLifecycles);
  expect(trade?.state).toBe('CLOSED');
  expect((await db.select().from(accounts))[0]!.equityBaseline).toBe(
    '100.000000000000000000',
  );
  const events = await db
    .select()
    .from(runtimeEvents)
    .where(eq(runtimeEvents.botId, bot.id));
  expect(
    events.some(
      (e) =>
        (e.details as { to?: { trading?: string } }).to?.trading ===
        'PENDING_ENTRY',
    ),
  ).toBe(true);
});
it('deduplicates candle closes and entry fills and never evaluates a new entry while in trade', async () => {
  const a = await fill();
  const report = (await adapter.reconcile(bot.id)).find(
    (r) => r.kind === 'ENTRY_FILL',
  )!;
  await runtime.report(report);
  expect((await store.load(bot.id)).trade?.filledQuantity).toBe(
    '1.000000000000000000',
  );
  const original = strategyInput('trend-long');
  await runtime.candle(original.trigger, original.candles, true);
  expect(await db.select().from(evaluations)).toHaveLength(1);
  const next = strategyInput('trend-short');
  next.trigger.eventTime += 900000;
  next.trigger.observedAt += 900000;
  next.candles['15m'] = next.candles['15m']!.map((c) => ({
    ...c,
    openTime: c.openTime + 900000,
    closeTime: c.closeTime + 900000,
    availableAt: c.availableAt + 900000,
    observedAt: c.observedAt + 900000,
  }));
  clock.time = next.trigger.observedAt;
  await Promise.all([
    runtime.price(tick('203')),
    runtime.candle(next.trigger, next.candles, true),
    runtime.price(tick('198')),
  ]);
  expect(await db.select().from(evaluations)).toHaveLength(1);
  expect(
    (await db.select().from(runtimeActions)).filter((x) => x.kind === 'CLOSE'),
  ).toHaveLength(1);
  expect(
    (await db.select().from(runtimeActions)).filter((x) => x.kind === 'ENTRY'),
  ).toHaveLength(1);
});
it('expires unfilled entries and reconciles fills racing cancellation without discarding partial exposure', async () => {
  const a = await entry();
  clock.advance(1000);
  await adapter.append({
    eventId: 'racing-fill',
    actionId: a.id,
    tradeId: a.tradeId,
    botId: bot.id,
    kind: 'ENTRY_FILL',
    quantity: '0.4',
    price: '199.8',
    eventTime: clock.time,
  });
  clock.time = closeTime + 1800001;
  await runtime.timer();
  const v = await store.load(bot.id);
  expect(v.trading).toBe('IN_TRADE');
  expect(v.trade?.filledQuantity).toBe('0.400000000000000000');
  expect(v.trade?.entryTerminal).toBe(true);
  expect(v.trade?.protectionStatus).toBe('CONFIRMED');
  expect(v.actions.some((a) => a.kind === 'CLOSE')).toBe(false);
});
it('expires an entry with no fill to IDLE, retaining a terminal EXPIRED lifecycle', async () => {
  await entry();
  clock.time = closeTime + 1800001;
  await runtime.timer();
  expect((await store.load(bot.id)).trading).toBe('IDLE');
  expect((await db.select().from(tradeLifecycles))[0]!.state).toBe('EXPIRED');
});
it('pause preserves exposure monitoring and stop waits for confirmed resolution', async () => {
  await fill();
  await command('PAUSE');
  expect((await store.load(bot.id)).operational).toBe('PAUSED');
  await command('STOP');
  expect((await store.load(bot.id)).operational).toBe('STOP_REQUESTED');
  clock.advance(1000);
  await runtime.price(tick('198'));
  const close = (await store.load(bot.id)).actions.find(
    (a) => a.kind === 'CLOSE',
  )!;
  expect(close).toBeDefined();
  await append(close, 'EXIT_FILL', {
    quantity: '1',
    price: '198',
    terminal: true,
  });
  expect((await store.load(bot.id)).operational).toBe('STOPPED');
});
it('restores unresolved/open state with durable fake facts and fences the old worker', async () => {
  await fill();
  const old = runtime;
  await store.release(lease);
  const takeover = (await store.acquire(bot.id, randomUUID()))!;
  expect(takeover.token).toBeGreaterThan(lease.token);
  const freshStore = new PostgresRuntimeRepository(db),
    freshAdapter = new DurableFakeExecutionAdapter(db, {}, clock),
    restored = new BotRuntime(
      freshStore,
      takeover,
      freshAdapter,
      trendFollowing,
      codeHash,
      new PostgresEvaluationRepository(db, takeover),
      clock,
    );
  await restored.restore();
  await restored.ready(true);
  await restored.ready(true);
  expect((await freshStore.load(bot.id)).trading).toBe('IN_TRADE');
  expect((await freshStore.load(bot.id)).trade?.confirmedStop).toBe(
    '198.600000000000000000',
  );
  await expect(old.price(tick('198'))).rejects.toThrow(/FENCED/);
  expect(
    (await db.select().from(runtimeActions)).filter((a) => a.kind === 'CLOSE'),
  ).toHaveLength(0);
});
it('keeps desired/submitted/confirmed stops separate until an adapter acknowledgment', async () => {
  adapter = new DurableFakeExecutionAdapter(db, { AMEND_STOP: 'DEFER' }, clock);
  runtime = new BotRuntime(
    store,
    lease,
    adapter,
    trendFollowing,
    codeHash,
    new PostgresEvaluationRepository(db, lease),
    clock,
  );
  await fill();
  clock.advance(1000);
  await runtime.price(tick('201.1'));
  let view = await store.load(bot.id);
  expect(view.trade!.desiredStop).not.toBe(view.trade!.confirmedStop);
  expect(view.trade!.confirmedStop).toBe('198.600000000000000000');
  const amendment = view.actions.find((a) => a.kind === 'AMEND_STOP')!;
  expect(amendment.state).toBe('SUBMITTING');
  await append(amendment, 'STOP_CONFIRMED', {
    quantity: amendment.quantity,
    stopPrice: amendment.stopPrice!,
    revision: amendment.revision,
  });
  view = await store.load(bot.id);
  expect(view.trade!.confirmedStop).toBe(view.trade!.submittedStop);
});
it('unknown submissions freeze new entries and do not blindly resubmit', async () => {
  adapter = new DurableFakeExecutionAdapter(db, { ENTRY: 'UNKNOWN' }, clock);
  runtime = new BotRuntime(
    store,
    lease,
    adapter,
    trendFollowing,
    codeHash,
    new PostgresEvaluationRepository(db, lease),
    clock,
  );
  await start();
  clock.time = closeTime + 2000;
  const input = strategyInput('trend-long');
  await runtime.candle(input.trigger, input.candles, true);
  expect((await store.load(bot.id)).trading).toBe('UNRESOLVED');
  await runtime.reconcile();
  await runtime.ready(true);
  expect((await store.load(bot.id)).operational).toBe('RECONCILING');
  expect(
    (await db.select().from(runtimeActions)).filter((a) => a.kind === 'ENTRY'),
  ).toHaveLength(1);
});
it('commands are authorized, durable, retry-safe requests with truthful pending status', async () => {
  const app = createApp(db, pool, createLogger('test', 'silent')),
    key = randomUUID();
  await request(app)
    .post(`/api/bots/${bot.id}/start`)
    .send({ reason: 'Start fixture' })
    .expect(401);
  const send = () =>
    request(app)
      .post(`/api/bots/${bot.id}/start`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ reason: 'Start fixture' });
  const first = await send().expect(202),
    second = await send().expect(202);
  expect(first.body.data.status).toBe('PENDING');
  expect(first.body.data.id).toBe(second.body.data.id);
  expect(await db.select().from(runtimeCommands)).toHaveLength(1);
  await runtime.command(first.body.data);
  expect((await db.select().from(runtimeCommands))[0]!.status).toBe('APPLIED');
  await request(app)
    .post(`/api/bots/${bot.id}/pause`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({ reason: 'Different request' })
    .expect(409);
  const state = await request(app)
    .get(`/api/bots/${bot.id}/runtime`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  expect(state.body.data.executionBackend).toBe('FAKE_CONTRACT');
});
it('database guards reject phantom IDLE and unmanaged state writes', async () => {
  await fill();
  await expect(
    db
      .update(bots)
      .set({ tradingState: 'IDLE', version: 99 })
      .where(eq(bots.id, bot.id)),
  ).rejects.toThrow();
  await expect(
    db.update(tradeLifecycles).set({ state: 'CLOSED' }),
  ).rejects.toThrow();
  await expect(
    botRepo.update(
      actor,
      bot.id,
      {
        allocationTargetPercent: '30',
        expectedVersion: 1,
        reason: 'Unsafe in-trade change',
      },
      randomUUID(),
    ),
  ).rejects.toThrow();
});

it('reconciles partial close quantities without simultaneous competing close orders', async () => {
  await fill();
  clock.advance(1000);
  await runtime.price(tick('203'));
  let v = await store.load(bot.id);
  const first = v.actions.find((a) => a.kind === 'CLOSE')!;
  await append(first, 'EXIT_FILL', {
    quantity: '0.4',
    price: '203',
    terminal: true,
  });
  v = await store.load(bot.id);
  expect(v.trading).toBe('CLOSING');
  const second = v.actions.find(
    (a) => a.kind === 'CLOSE' && a.id !== first.id,
  )!;
  expect(second.quantity).toBe('0.600000000000000000');
  await append(second, 'EXIT_FILL', {
    quantity: '0.6',
    price: '203',
    terminal: true,
  });
  expect((await store.load(bot.id)).trading).toBe('IDLE');
});
it('rejects takeover of a current lease and prevents stale fake submissions after token turnover', async () => {
  expect(await store.acquire(bot.id, randomUUID())).toBeNull();
  const a = await entry();
  await store.release(lease);
  const next = (await store.acquire(bot.id, randomUUID()))!;
  expect(next.token).toBeGreaterThan(lease.token);
  await expect(adapter.submit(a, lease)).rejects.toThrow(/FENCED/);
});
it('warms and controls bots through the supervisor using an injected public-data fake', async () => {
  const { RuntimeSupervisor } =
    await import('../../apps/runtime/src/supervisor.js');
  const { MarketDataService } =
    await import('../../packages/market-data/src/service.js');
  const { PostgresCandleRepository } =
    await import('../../packages/database/src/market-data.js');
  const { FakeMarketDataProvider } = await import('../fixtures/market.js');
  await store.release(lease);
  const feed = new FakeMarketDataProvider(clock),
    data = new MarketDataService(feed, new PostgresCandleRepository(db), clock),
    supervisor = new RuntimeSupervisor(
      db,
      data,
      createLogger('test', 'silent'),
      clock,
    );
  try {
    await controls.enqueue(
      actor,
      bot.id,
      'START',
      randomUUID(),
      'Supervisor start',
      randomUUID(),
    );
    await supervisor.poll();
    await supervisor.poll();
    expect((await store.load(bot.id)).operational).toBe('RUNNING');
    await controls.enqueue(
      actor,
      bot.id,
      'PAUSE',
      randomUUID(),
      'Supervisor pause',
      randomUUID(),
    );
    await supervisor.poll();
    expect((await store.load(bot.id)).operational).toBe('PAUSED');
    await controls.enqueue(
      actor,
      bot.id,
      'RESUME',
      randomUUID(),
      'Supervisor resume',
      randomUUID(),
    );
    await supervisor.poll();
    await supervisor.poll();
    expect((await store.load(bot.id)).operational).toBe('RUNNING');
    await controls.enqueue(
      actor,
      bot.id,
      'STOP',
      randomUUID(),
      'Supervisor stop',
      randomUUID(),
    );
    await supervisor.poll();
    expect((await store.load(bot.id)).operational).toBe('STOPPED');
    expect(supervisor.health().ownedBots).toBe(0);
  } finally {
    await supervisor.close();
    data.close();
    await data.drain();
  }
});
