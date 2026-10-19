import { paperPolicy } from '../../packages/risk/src/sizing.js';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import request from 'supertest';
import {
  connectDatabase,
  users,
  accounts,
  tokens,
  paperReports,
} from '../../packages/database/src/index.js';
import { migrateDatabase } from '../../packages/database/src/migrate.js';
import { registerResearchStrategies } from '../../packages/database/src/strategies.js';
import {
  PostgresRuntimeRepository,
  RuntimeControlRepository,
} from '../../packages/database/src/runtime.js';
import { PaperExecutionAdapter } from '../../packages/database/src/paper-execution.js';
import { PostgresCandleRepository } from '../../packages/database/src/market-data.js';
import { PaperCapitalRepository } from '../../packages/database/src/capital.js';
import { fixtureInstrument } from '../fixtures/market.js';
import { Decimal } from 'decimal.js';
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
import type { Lease, Report } from '../../packages/runtime/src/contracts.js';
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
  adapter: PaperExecutionAdapter,
  runtime: BotRuntime,
  clock: VirtualClock,
  codeHash: string,
  token: string;
beforeAll(() => migrateDatabase(url));
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query(
    'TRUNCATE market_instruments,audit_events,bot_config_versions,coin_ownership,bots,api_tokens,exchange_accounts,strategy_versions,strategies,app_users CASCADE',
  );
  const [owner] = await db
    .insert(users)
    .values({ email: 'runtime-owner@fixture.local' })
    .returning();
  await db
    .insert(accounts)
    .values({ ownerUserId: owner!.id, name: 'Funded paper portfolio' });
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
  clock = new VirtualClock(closeTime + 2000);
  lease = (await store.acquire(bot.id, randomUUID()))!;
  adapter = new PaperExecutionAdapter(db, clock);
  await new PostgresCandleRepository(db).saveInstrument(
    fixtureInstrument(market, clock.time),
  );
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

const manager = new PositionManager();
async function start() {
  for (const kind of ['START'] as const) {
    const cmd = await controls.enqueue(
      actor,
      bot.id,
      kind,
      randomUUID(),
      'Test',
      randomUUID(),
    );
    await runtime.command(cmd as never);
  }
  await runtime.ready(true);
  await runtime.ready(true);
}
async function enter(
  orderType: 'MARKET' | 'LIMIT' = 'MARKET',
  stop = '99',
  entryStore = store,
) {
  await start();
  const evaluation = await new (
    await import('../../packages/strategies/src/engine.js')
  ).StrategyEngine(new PostgresEvaluationRepository(db, lease)).evaluate(
    trendFollowing,
    {
      ...strategyInput('trend-long'),
      botId: bot.id,
      accountId: bot.accountId,
      strategyVersionId: bot.strategyVersionId,
      codeHash,
      configVersion: 1,
    },
    randomUUID(),
  );
  // Controlled OMS fixture uses an actionable, durable evaluation; strategy's normal path is also tested separately.
  await entryStore.transact(
    lease,
    `paper-entry:${evaluation.id}`,
    clock.time,
    (v) => {
      const c = manager.entry(
        v,
        {
          action: 'PROPOSE_ENTRY',
          side: 'LONG',
          orderType,
          entryPrice: '100',
          stopLoss: stop,
          takeProfit: '110',
          expiresAt: clock.time + 300000,
          reason: 'TREND_CONFIRMED',
        },
        evaluation.id,
        structuredClone(trendFollowing.managementPolicy),
        clock.time,
      );
      c.view.trade!.executionBackend = 'PAPER';
      return c;
    },
  );
  await runtime.reconcile();
  return store.load(bot.id);
}
async function tick(price: string, quantity = '100') {
  clock.advance(1000);
  await runtime.price({
    kind: 'PRICE',
    marketKey: bot.canonicalMarketId,
    tradeId: randomUUID(),
    eventTime: clock.time,
    observedAt: clock.time,
    price,
    quantity,
    reference: 'LAST',
    side: 'SELL',
    late: false,
  });
}
const capital = () =>
  new PaperCapitalRepository(db).snapshot(bot.accountId, clock.time);
it('reserves without changing equity, handles partial fills and protection, closes after restart, deduplicates fills', async () => {
  let v = await enter();
  expect(v.trade?.executionBackend).toBe('PAPER');
  expect(new Decimal((await capital())[0]!.balance).eq(20)).toBe(true);
  await tick('99.95', '.2');
  v = await store.load(bot.id);
  expect(v.trade?.filledQuantity).toBe('0.020000000000000000');
  expect(v.trade?.protectionStatus).toBe('CONFIRMED');
  expect(new Decimal(v.trade!.protectedQuantity).eq('.02')).toBe(true);
  await tick('99.95');
  v = await store.load(bot.id);
  expect(
    new Decimal(v.trade!.filledQuantity).eq(v.trade!.requestedQuantity),
  ).toBe(true);
  const rows = await capital(),
    balance = rows[0]!.balance;
  await runtime.reconcile();
  expect((await capital())[0]!.balance).toBe(balance);
  await store.release(lease);
  lease = (await store.acquire(bot.id, randomUUID()))!;
  runtime = new BotRuntime(
    store,
    lease,
    new PaperExecutionAdapter(db, clock),
    trendFollowing,
    codeHash,
    new PostgresEvaluationRepository(db, lease),
    clock,
  );
  await runtime.restore();
  await runtime.ready(true);
  await runtime.ready(true);
  await tick('98');
  await tick('98');
  expect((await store.load(bot.id)).trading).toBe('IDLE');
  const reservations = await pool.query(
    'SELECT reserved,committed FROM paper_reservations',
  );
  expect(
    new Decimal(reservations.rows[0].reserved)
      .plus(reservations.rows[0].committed)
      .isZero(),
  ).toBe(true);
  expect(new Decimal((await capital())[0]!.balance).lt(20)).toBe(true);
  await runtime.reconcile();
  expect((await store.load(bot.id)).trading).toBe('IDLE');
});
it('does not fill at decision time, above limit, with stale/late data or zero liquidity; expires unfilled reservation', async () => {
  const v = await enter('LIMIT');
  await runtime.price({
    kind: 'PRICE',
    marketKey: bot.canonicalMarketId,
    tradeId: randomUUID(),
    eventTime: clock.time,
    observedAt: clock.time,
    price: '99',
    quantity: '100',
    reference: 'LAST',
    side: 'SELL',
    late: false,
  });
  await tick('101');
  await tick('99', '0');
  expect(
    new Decimal((await store.load(bot.id)).trade!.filledQuantity).isZero(),
  ).toBe(true);
  clock.advance(300000);
  await runtime.timer();
  expect((await store.load(bot.id)).trading).toBe('IDLE');
  expect(new Decimal((await capital())[0]!.balance).eq(20)).toBe(true);
  expect(v.trade).not.toBeNull();
});
it('rejects orders below instrument minimum without creating intents or reservations', async () => {
  await new PostgresCandleRepository(db).saveInstrument({
    ...fixtureInstrument(market, clock.time),
    specVersion: 'too-large',
    minNotional: '1000',
  });
  await enter();
  expect((await store.load(bot.id)).trade).toBeNull();
  expect((await pool.query('SELECT * FROM paper_reservations')).rowCount).toBe(
    0,
  );
  expect(
    (
      await pool.query(
        "SELECT details FROM runtime_events WHERE kind='risk.rejected'",
      )
    ).rows[0].details.reason,
  ).toBe('MIN_ORDER_NOT_MET');
});

it('attributes a $0.50 net loss once to Bot A, leaves Bot B at $20 and never credits released margin as profit', async () => {
  const other = await botRepo.create(
    actor,
    {
      name: 'Independent B',
      market: { ...market, baseAsset: 'ETH' },
      strategyVersionId: bot.strategyVersionId,
      executionMode: 'PAPER',
      riskProfile: 'CONSERVATIVE',
      allocationTargetPercent: '20',
    },
    randomUUID(),
  );
  let v = await enter('MARKET', '98.9');
  const journal = new DurableFakeExecutionAdapter(db, {}, clock, paperReports);
  const entry = v.actions.find((a) => a.kind === 'ENTRY')!;
  const fill: Report = {
    eventId: randomUUID(),
    actionId: entry.id,
    tradeId: entry.tradeId,
    botId: bot.id,
    kind: 'ENTRY_FILL',
    eventTime: clock.time + 1000,
    quantity: '.07',
    price: '100',
    fee: '0.005',
  };
  // A controlled fee/fill fixture: .07*(93-100) - .005 - .005 = -.50 exactly.
  fill.quantity = '0.07';
  await journal.append(fill, lease);
  await runtime.report(fill);
  await runtime.report(fill);
  await store.transact(lease, randomUUID(), clock.time, (v) =>
    manager.pendingInvalidated(v, 'TEST_REMAINDER_CANCEL', clock.time),
  );
  await runtime.reconcile();
  await store.transact(lease, randomUUID(), clock.time, (v) =>
    manager.close(v, 'TEST_GAP_EXIT', clock.time),
  );
  await runtime.reconcile();
  v = await store.load(bot.id);
  const close = v.actions.find((a) => a.kind === 'CLOSE')!;
  const exit: Report = {
    eventId: randomUUID(),
    actionId: close.id,
    tradeId: close.tradeId,
    botId: bot.id,
    kind: 'EXIT_FILL',
    eventTime: clock.time + 2000,
    quantity: '0.07',
    price: '93',
    fee: '0.005',
    terminal: true,
  };
  await journal.append(exit, lease);
  await runtime.report(exit);
  await runtime.report(exit);
  await runtime.reconcile();
  const balances = await capital();
  expect(
    new Decimal(balances.find((s) => s.bot_id === bot.id)!.balance).eq('19.50'),
  ).toBe(true);
  expect(
    new Decimal(balances.find((s) => s.bot_id === other.id)!.balance).eq('20'),
  ).toBe(true);
  expect((await store.load(bot.id)).trading).toBe('IDLE');
  const ledger = await pool.query(
    'SELECT kind,amount FROM paper_capital_ledger WHERE bot_id=$1 ORDER BY sequence',
    [bot.id],
  );
  expect(ledger.rows.map((r) => r.kind)).toEqual([
    'FUNDING',
    'FEE',
    'GROSS_PNL',
    'FEE',
  ]);
  await expect(
    pool.query('UPDATE paper_capital_ledger SET amount=100 WHERE bot_id=$1', [
      bot.id,
    ]),
  ).rejects.toThrow();
  await store.transact(lease, randomUUID(), clock.time, (v) => {
    const c = manager.entry(
      v,
      {
        action: 'PROPOSE_ENTRY',
        side: 'LONG',
        orderType: 'MARKET',
        entryPrice: '100',
        stopLoss: '99',
        takeProfit: '110',
        expiresAt: clock.time + 300000,
        reason: 'TREND_CONFIRMED',
      },
      fill.tradeId,
      structuredClone(trendFollowing.managementPolicy),
      clock.time,
    );
    c.view.trade!.executionBackend = 'PAPER';
    return c;
  });
  expect((await store.load(bot.id)).trade).toBeNull();
  expect(
    (
      await pool.query(
        "SELECT details FROM runtime_events WHERE kind='risk.rejected' ORDER BY event_time DESC LIMIT 1",
      )
    ).rows[0].details.reason,
  ).toBe('BOT_LOSS_GUARD');
});
it('serializes concurrent account reservations so independent bots cannot jointly exceed gross exposure', async () => {
  const make = async (baseAsset: string) => {
    const b = await botRepo.create(
      actor,
      {
        name: baseAsset,
        market: { ...market, baseAsset },
        strategyVersionId: bot.strategyVersionId,
        executionMode: 'PAPER',
        riskProfile: 'AGGRESSIVE',
        allocationTargetPercent: '30',
      },
      randomUUID(),
    );
    const l = (await store.acquire(b.id, randomUUID()))!;
    const rt = new BotRuntime(
      store,
      l,
      new PaperExecutionAdapter(db, clock),
      trendFollowing,
      codeHash,
      new PostgresEvaluationRepository(db, l),
      clock,
    );
    const cmd = await controls.enqueue(
      actor,
      b.id,
      'START',
      randomUUID(),
      'Fixture',
      randomUUID(),
    );
    await rt.command(cmd as never);
    await rt.ready(true);
    await rt.ready(true);
    await new PostgresCandleRepository(db).saveInstrument(
      fixtureInstrument(b.market as typeof market, clock.time),
    );
    const input = strategyInput('trend-long');
    input.botId = b.id;
    input.accountId = b.accountId;
    input.strategyVersionId = b.strategyVersionId;
    input.codeHash = codeHash;
    input.market = b.market as typeof market;
    for (const bars of Object.values(input.candles))
      for (const bar of bars!) bar.marketKey = b.canonicalMarketId;
    const e = await new (
      await import('../../packages/strategies/src/engine.js')
    ).StrategyEngine(new PostgresEvaluationRepository(db, l)).evaluate(
      trendFollowing,
      input,
      randomUUID(),
    );
    return { b, l, e };
  };
  const left = await make('ETH'),
    right = await make('SOL');
  const reserve = ({ b, l, e }: typeof left) =>
    store.transact(l, randomUUID(), clock.time, (v) => {
      const c = manager.entry(
        v,
        {
          action: 'PROPOSE_ENTRY',
          side: 'LONG',
          orderType: 'MARKET',
          entryPrice: '100',
          stopLoss: '99.5',
          takeProfit: '110',
          expiresAt: clock.time + 300000,
          reason: 'TREND_CONFIRMED',
        },
        e.id,
        structuredClone(trendFollowing.managementPolicy),
        clock.time,
      );
      c.view.trade!.executionBackend = 'PAPER';
      return c;
    });
  const results = await Promise.all([reserve(left), reserve(right)]);
  expect(results.filter((v) => v.trade !== null)).toHaveLength(1);
  const totals = await pool.query(
    'SELECT sum(notional) AS notional,sum(reserved+committed) AS capacity,sum(stop_exposure) AS stop FROM paper_reservations',
  );
  expect(new Decimal(totals.rows[0].notional).lte(100)).toBe(true);
  expect(new Decimal(totals.rows[0].capacity).lte(40)).toBe(true);
  expect(new Decimal(totals.rows[0].stop).lte(2)).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT details FROM runtime_events WHERE kind='risk.rejected'",
      )
    ).rows[0].details.reason,
  ).toBe('PORTFOLIO_EXPOSURE_LIMIT');
});
it('normal strategy evaluation reaches a real risk-sized PAPER intent', async () => {
  clock.time = closeTime - 900000;
  await start();
  clock.time = closeTime + 2000;
  await new PostgresCandleRepository(db).saveInstrument(
    fixtureInstrument(market, clock.time),
  );
  const input = strategyInput('trend-long');
  await runtime.candle(input.trigger, input.candles, true);
  const view = await store.load(bot.id);
  expect(view.trade?.executionBackend).toBe('PAPER');
  expect(new Decimal(view.trade!.requestedQuantity).lt(1)).toBe(true);
  await tick(
    new Decimal(view.trade!.entryReference).mul('.9995').toFixed(8),
    '1000',
  );
  const filled = await store.load(bot.id);
  expect(filled.trade?.entryTerminal).toBe(true);
  await store.release(lease);
  lease = (await store.acquire(bot.id, randomUUID()))!;
  runtime = new BotRuntime(
    store,
    lease,
    new PaperExecutionAdapter(db, clock),
    trendFollowing,
    codeHash,
    new PostgresEvaluationRepository(db, lease),
    clock,
  );
  await runtime.restore();
  await runtime.ready(true);
  await runtime.ready(true);
  const stopPrice = new Decimal(filled.trade!.initialStop)
    .mul('.99')
    .toFixed(8);
  await tick(stopPrice, '1000');
  await tick(stopPrice, '1000');
  expect((await store.load(bot.id)).trading).toBe('IDLE');
  expect(new Decimal((await capital())[0]!.balance).lt(20)).toBe(true);
});
it('keeps unknown submissions reserved until authoritative cancellation and rejects reports without durable evidence', async () => {
  const view = await enter(),
    entry = view.actions.find((a) => a.kind === 'ENTRY')!;
  const journal = new DurableFakeExecutionAdapter(db, {}, clock, paperReports);
  await expect(
    runtime.report({
      eventId: randomUUID(),
      botId: bot.id,
      tradeId: entry.tradeId,
      actionId: entry.id,
      kind: 'ENTRY_CANCELLED',
      eventTime: clock.time,
    }),
  ).rejects.toThrow('PAPER_REPORT_EVIDENCE_MISMATCH');
  const unknown: Report = {
    eventId: randomUUID(),
    botId: bot.id,
    tradeId: entry.tradeId,
    actionId: entry.id,
    kind: 'UNKNOWN',
    eventTime: clock.time,
  };
  await journal.append(unknown, lease);
  await runtime.report(unknown);
  expect((await store.load(bot.id)).trading).toBe('UNRESOLVED');
  expect(new Decimal((await capital())[0]!.reserved).gt(0)).toBe(true);
  expect(new Decimal((await capital())[0]!.balance).eq(20)).toBe(true);
  const cancel: Report = {
    ...unknown,
    eventId: randomUUID(),
    kind: 'ENTRY_CANCELLED',
  };
  await journal.append(cancel, lease);
  await runtime.report(cancel);
  expect((await store.load(bot.id)).trading).toBe('IDLE');
  expect(new Decimal((await capital())[0]!.reserved).isZero()).toBe(true);
});
it('deduplicates price volume durably and ignores stale, late, future and regressing observations', async () => {
  await enter();
  clock.advance(1000);
  const event = {
    kind: 'PRICE' as const,
    marketKey: bot.canonicalMarketId,
    tradeId: randomUUID(),
    eventTime: clock.time,
    observedAt: clock.time,
    price: '99.95',
    quantity: '0.2',
    reference: 'LAST' as const,
    side: 'SELL' as const,
    late: false,
  };
  await runtime.price(event);
  await runtime.price(event);
  let view = await store.load(bot.id);
  expect(new Decimal(view.trade!.filledQuantity).eq('.02')).toBe(true);
  await expect(runtime.price({ ...event, price: '99.96' })).rejects.toThrow(
    'PAPER_PRICE_EVENT_CONFLICT',
  );
  for (const overrides of [
    { late: true },
    { eventTime: clock.time - 1 },
    { observedAt: clock.time + 10000, eventTime: clock.time + 10000 },
    { observedAt: clock.time - 6000, eventTime: clock.time - 6000 },
  ]) {
    await runtime.price({ ...event, tradeId: randomUUID(), ...overrides });
  }
  view = await store.load(bot.id);
  expect(new Decimal(view.trade!.filledQuantity).eq('.02')).toBe(true);
});
it('reports owner-scoped PAPER capital and treats target changes and repeated funding as no top-up', async () => {
  const app = createApp(db, pool, createLogger('test', 'silent'));
  const initial = await request(app)
    .get('/api/account/capital')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  expect(initial.body.data.environment).toBe('PAPER');
  expect(initial.body.data.bots).toHaveLength(1);
  await botRepo.update(
    actor,
    bot.id,
    {
      allocationTargetPercent: '30',
      expectedVersion: 1,
      reason: 'Target only',
    },
    randomUUID(),
  );
  const funded = await request(app)
    .post(`/api/bots/${bot.id}/initial-funding`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'Retry initial funding' })
    .expect(200);
  expect(new Decimal(funded.body.data.amount).eq(20)).toBe(true);
  expect(new Decimal((await capital())[0]!.balance).eq(20)).toBe(true);
  expect((await capital())[0]!.targetAllocationPercent).toBe('30.000000');
  const [other] = await db
    .insert(users)
    .values({ email: 'foreign-paper@fixture.local' })
    .returning();
  await db.insert(accounts).values({ ownerUserId: other!.id, name: 'Foreign' });
  const foreignToken = randomBytes(32).toString('base64url');
  await db.insert(tokens).values({
    userId: other!.id,
    tokenHash: createHash('sha256').update(foreignToken).digest('hex'),
    role: 'OWNER',
    expiresAt: new Date(Date.now() + 60000),
  });
  const foreign = await request(app)
    .get('/api/account/capital')
    .set('Authorization', `Bearer ${foreignToken}`)
    .expect(200);
  expect(foreign.body.data.bots).toEqual([]);
  await request(app)
    .post(`/api/bots/${bot.id}/initial-funding`)
    .set('Authorization', `Bearer ${foreignToken}`)
    .send({ reason: 'Invalid' })
    .expect(404);
});

it.each([
  { accountMargin: '.01' },
  { accountNotional: '.01' },
  { accountStop: '.0001' },
])('enforces configurable portfolio ceilings %j', async (limits) => {
  const restricted = new PostgresRuntimeRepository(db, {
    ...paperPolicy,
    ...limits,
  });
  await enter('MARKET', '99', restricted);
  expect((await store.load(bot.id)).trade).toBeNull();
  expect(
    (
      await pool.query(
        "SELECT details FROM runtime_events WHERE kind='risk.rejected'",
      )
    ).rows[0].details.reason,
  ).toBe('PORTFOLIO_EXPOSURE_LIMIT');
});
it('recovers a durable PAPER fill after a crash before its financial posting, once, under the new lease', async () => {
  const v = await enter(),
    entry = v.actions.find((a) => a.kind === 'ENTRY')!;
  const journal = new DurableFakeExecutionAdapter(db, {}, clock, paperReports);
  const fill: Report = {
    eventId: randomUUID(),
    botId: bot.id,
    tradeId: entry.tradeId,
    actionId: entry.id,
    kind: 'ENTRY_FILL',
    eventTime: clock.time,
    quantity: '0.01',
    price: '100',
    fee: '0.0006',
  };
  await journal.append(fill, lease);
  expect(new Decimal((await capital())[0]!.balance).eq(20)).toBe(true);
  const staleLease = lease;
  await store.release(lease);
  lease = (await store.acquire(bot.id, randomUUID()))!;
  runtime = new BotRuntime(
    store,
    lease,
    new PaperExecutionAdapter(db, clock),
    trendFollowing,
    codeHash,
    new PostgresEvaluationRepository(db, lease),
    clock,
  );
  await runtime.restore();
  await runtime.reconcile();
  expect(new Decimal((await capital())[0]!.balance).eq('19.9994')).toBe(true);
  expect(
    new Decimal((await store.load(bot.id)).trade!.filledQuantity).eq('.01'),
  ).toBe(true);
  expect((await store.load(bot.id)).trade!.protectionStatus).toBe('CONFIRMED');
  await expect(
    journal.append({ ...fill, eventId: randomUUID() }, staleLease),
  ).rejects.toThrow('FENCED');
});
it('can explicitly fund an initially zero-allocation bot after its first positive target without writing zero principal', async () => {
  const empty = await botRepo.create(
    actor,
    {
      name: 'Unfunded',
      market: { ...market, baseAsset: 'ETH' },
      strategyVersionId: bot.strategyVersionId,
      executionMode: 'PAPER',
      riskProfile: 'CONSERVATIVE',
      allocationTargetPercent: '0',
    },
    randomUUID(),
  );
  const repo = new PaperCapitalRepository(db);
  await expect(
    repo.fundInitial(actor, empty.id, 'No target', randomUUID()),
  ).rejects.toThrow('positive target');
  await botRepo.update(
    actor,
    empty.id,
    {
      allocationTargetPercent: '20',
      expectedVersion: 1,
      reason: 'Initial target',
    },
    randomUUID(),
  );
  const funding = await repo.fundInitial(
    actor,
    empty.id,
    'Initialize',
    randomUUID(),
  );
  expect(new Decimal(funding!.amount).eq(20)).toBe(true);
  expect(
    (
      await pool.query(
        'SELECT count(*) FROM paper_capital_ledger WHERE bot_id=$1',
        [empty.id],
      )
    ).rows[0].count,
  ).toBe('1');
});
