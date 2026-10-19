import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { loadEnvFile } from 'node:process';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  connectDatabase,
  users,
  accounts,
  replayRuns,
  bots,
  evaluations,
  capitalLedger,
  recoveryGaps,
} from '../../packages/database/src/index.js';
import { migrateDatabase } from '../../packages/database/src/migrate.js';
import {
  enqueueReplay,
  executeReplay,
} from '../../packages/replay/src/runner.js';
import { replayFixture } from '../fixtures/replay.js';
import {
  digest,
  type ReplayEvent,
} from '../../packages/replay/src/contracts.js';
import type { Actor } from '../../packages/database/src/bots.js';
import { closeTime } from '../fixtures/strategies.js';
try {
  loadEnvFile('.env');
} catch {}
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Dedicated test DB required');
const { db, pool } = connectDatabase(url);
let actor: Actor;
beforeAll(() => migrateDatabase(url));
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query(
    'TRUNCATE app_users,strategies,exchange_accounts,bots,audit_events CASCADE',
  );
  const [user] = await db
    .insert(users)
    .values({ email: 'replay-owner@fixture.local' })
    .returning();
  await db
    .insert(accounts)
    .values({ ownerUserId: user!.id, name: 'Forward portfolio' });
  actor = { userId: user!.id, role: 'OWNER' };
});
async function run(input = replayFixture()) {
  const r = await enqueueReplay(db, actor, input);
  return { row: r, report: (await executeReplay(db, r.id))! };
}
it('replays the same core modules reproducibly with fees, funding, slippage and isolated ledgers', async () => {
  const a = await run(),
    b = await run();
  expect(a.report).toEqual(b.report);
  const golden = JSON.parse(
    readFileSync(
      new URL('../fixtures/golden/replay.json', import.meta.url),
      'utf8',
    ),
  );
  expect({ metrics: a.report.metrics, trades: a.report.trades }).toEqual(
    golden,
  );
  expect(a.report.metrics.evaluations).toBe(1);
  expect(a.report.metrics.closedTrades).toBe(1);
  expect(a.report.metrics.filledTrades).toBe(1);
  expect(a.report.metrics.funding).not.toBe('0');
  expect(a.report.trades[0]!.closeReason).toBe('TAKE_PROFIT');
  expect(a.report.status).toBe('COMPLETE');
  expect(await db.select().from(bots)).toHaveLength(2);
  expect(
    (
      await db
        .select()
        .from(accounts)
        .where(eq(accounts.ownerUserId, actor.userId))
    )[0]!.replayScope,
  ).toBe('FORWARD');
});
it('does not use future candles or observations in an earlier decision', async () => {
  const input = replayFixture(),
    base = await run(input);
  const future = {
    ...input.dataset.candles.find((c) => c.timeframe === '15m')!,
    openTime: closeTime + 900000,
    closeTime: closeTime + 1800000,
    observedAt: closeTime + 1800000,
    availableAt: closeTime + 1800000,
    open: '1000',
    high: '1001',
    low: '999',
    close: '1000',
  };
  input.dataset.candles.push(future);
  const mutated = await run(input);
  expect(mutated.report.trades).toEqual(base.report.trades);
  const snapshots = await db.select().from(evaluations);
  expect(
    snapshots.every((e) =>
      Object.values((e.snapshot as any).context.candles)
        .flat()
        .every(
          (c: any) =>
            c.closeTime <= e.eventTime && c.availableAt <= e.decisionTime,
        ),
    ),
  ).toBe(true);
});
it('resumes after a price was processed but before replay checkpoint, without duplicate fills or costs', async () => {
  const expected = await run();
  const job = await enqueueReplay(db, actor, replayFixture()),
    abort = new AbortController();
  await executeReplay(db, job.id, {
    signal: abort.signal,
    afterDispatch: async (n) => {
      if (n === 1) abort.abort();
    },
  });
  const resumed = await executeReplay(db, job.id);
  expect(resumed).toEqual(expected.report);
});
it('recovers a complete ordered outage bundle and never fabricates a fill from incomplete evidence', async () => {
  const baseline = await run();
  const full = replayFixture(),
    events = full.dataset.events,
    buffer = events.slice(1, 5);
  full.dataset.events = [
    events[0]!,
    {
      kind: 'GAP_START',
      marketKey: full.dataset.instruments[0]!.marketKey,
      id: 'connection',
      observedAt: closeTime + 1500,
    },
    ...buffer,
    {
      kind: 'GAP_END',
      marketKey: full.dataset.instruments[0]!.marketKey,
      id: 'connection',
      observedAt: closeTime + 5000,
      complete: true,
      evidenceHash: digest(buffer),
    },
    events[5]!,
  ];
  const recovered = await run(full);
  expect(recovered.report.trades).toEqual(baseline.report.trades);
  expect(recovered.report.metrics.realizedNet).toBe(
    baseline.report.metrics.realizedNet,
  );
  const partial = structuredClone(full);
  const end = partial.dataset.events.find(
    (e) => e.kind === 'GAP_END',
  ) as Extract<ReplayEvent, { kind: 'GAP_END' }>;
  end.complete = false;
  const uncertain = await run(partial);
  expect(uncertain.report.status).toBe('RECONCILIATION_UNCERTAIN');
  expect(uncertain.report.metrics.filledTrades).toBe(0);
  expect(uncertain.report.metrics.realizedNet).toBe('0');
});
it('marks dual TP/SL candle-only evidence uncertain and leaves the ledger unchanged', async () => {
  const input = replayFixture();
  input.dataset.events = input.dataset.events.slice(0, 2);
  input.dataset.events.push({
    kind: 'GAP_START',
    marketKey: input.dataset.instruments[0]!.marketKey,
    id: 'ambiguous-bar',
    observedAt: closeTime + 2500,
  });
  const candle = {
    ...input.dataset.candles.find((c) => c.timeframe === '15m')!,
    openTime: closeTime,
    closeTime: closeTime + 900000,
    observedAt: closeTime + 900000,
    availableAt: closeTime + 900000,
    open: '199.8',
    high: '250',
    low: '150',
    close: '200',
  };
  input.end = closeTime + 901000;
  input.dataset.events.push(
    { kind: 'CANDLE', candle },
    {
      kind: 'GAP_END',
      marketKey: input.dataset.instruments[0]!.marketKey,
      id: 'ambiguous-bar',
      observedAt: input.end,
      complete: false,
    },
  );
  input.dataset.instruments[0]!.expiresAt = input.end + 1000;
  const result = await run(input);
  expect(result.report.status).toBe('RECONCILIATION_UNCERTAIN');
  expect(result.report.metrics.filledTrades).toBe(1);
  expect(result.report.metrics.closedTrades).toBe(0);
  expect(result.report.metrics.realizedNet).toBe(
    result.report.metrics.fees === '0' ? '0' : '-' + result.report.metrics.fees,
  );
});
it('shares portfolio risk and keeps both bot ledgers independent within one replay account', async () => {
  const input = replayFixture(),
    other = {
      ...input.bots[0]!,
      key: 'second',
      market: { ...input.bots[0]!.market, baseAsset: 'ETH' },
    };
  input.bots.push(other);
  const key = input.dataset.instruments[0]!.marketKey.replace('BTC', 'ETH');
  input.dataset.instruments.push({
    ...input.dataset.instruments[0]!,
    market: other.market,
    marketKey: key,
    symbol: 'ETHUSDT',
  });
  input.dataset.candles.push(
    ...input.dataset.candles.map((c) => ({ ...c, marketKey: key })),
  );
  input.dataset.events = input.dataset.events.flatMap((e): ReplayEvent[] => {
    if (e.kind === 'TIMER') return [e];
    return [
      e,
      e.kind === 'CANDLE'
        ? { ...e, candle: { ...e.candle, marketKey: key } }
        : { ...e, marketKey: key },
    ];
  });
  const result = await run(input);
  expect(result.report.metrics.closedTrades).toBe(2);
  expect(result.report.bots[0]!.balance).toBe(result.report.bots[1]!.balance);
  expect(result.report.bots.map((b) => b.principal)).toEqual(['20', '20']);
  const rejected = replayFixture();
  rejected.bots[0]!.allocationTargetPercent = '0.1';
  const risk = await run(rejected);
  expect(risk.report.metrics.riskRejections.MIN_ORDER_NOT_MET).toBe(1);
  expect(risk.report.metrics.filledTrades).toBe(0);
});
it('has deterministic partial liquidity and exposes fee/slippage sensitivity on identical data', async () => {
  const a = replayFixture();
  a.liquidity = { model: 'SEEDED_PARTICIPATION', minimumFactor: 0.1 };
  for (const e of a.dataset.events) if (e.kind === 'PRICE') e.quantity = '0.1';
  const first = await run(a),
    second = await run(a);
  expect(first.report).toEqual(second.report);
  expect(first.report.metrics.filledTrades).toBe(1);
  const b = replayFixture();
  b.policy = {
    ...b.policy,
    version: 'higher-cost-sensitivity',
    feeRate: '.001',
    costRate: '.004',
  };
  const base = await run(),
    sensitive = await run(b);
  expect(base.report.datasetHash).toBe(sensitive.report.datasetHash);
  expect(base.report.metrics.realizedNet).not.toBe(
    sensitive.report.metrics.realizedNet,
  );
});
it('keeps untouched holdout locked until training/test evidence is complete and a variant is selected', async () => {
  const { createExperiment, queueValidation, selectVariant } =
    await import('../../packages/replay/src/validation.js');
  const base = replayFixture(),
    events = structuredClone(base.dataset.events);
  base.dataset.events = [0, 900000, 1800000].flatMap((offset, n) =>
    events.map((e) => {
      if (e.kind === 'CANDLE')
        return {
          ...e,
          candle: {
            ...e.candle,
            openTime: e.candle.openTime + offset,
            closeTime: e.candle.closeTime + offset,
            observedAt: e.candle.observedAt + offset,
            availableAt: e.candle.availableAt + offset,
          },
        };
      if (e.kind === 'PRICE')
        return {
          ...e,
          tradeId: e.tradeId + '-' + n,
          eventTime: e.eventTime + offset,
          observedAt: e.observedAt + offset,
        };
      if (e.kind === 'FUNDING')
        return {
          ...e,
          period: e.period + offset,
          observedAt: e.observedAt + offset,
        };
      return { ...e, observedAt: e.observedAt + offset };
    }),
  );
  base.end += 1800000;
  const variant = structuredClone(base);
  variant.bots[0]!.management = {
    breakEven: { enabled: false, triggerR: 1, offsetR: 0 },
  };
  const experiment = await createExperiment(db, actor, {
    plan: {
      training: { start: base.start, end: base.start + 7000 },
      tests: [{ start: base.start + 900000, end: base.start + 907000 }],
      holdout: { start: base.start + 1800000, end: base.end },
    },
    variants: [
      { key: 'default', input: base },
      { key: 'without-be', input: variant },
    ],
  });
  await expect(
    queueValidation(db, actor, experiment.id, 'default', 'HOLDOUT'),
  ).rejects.toThrow('Select');
  await expect(
    selectVariant(db, actor, experiment.id, 'default', 'Premature'),
  ).rejects.toThrow('Complete');
  for (const v of ['default', 'without-be'])
    for (const stage of ['TRAIN', 'TEST'] as const) {
      const r = await queueValidation(db, actor, experiment.id, v, stage);
      await executeReplay(db, r.id);
    }
  await selectVariant(
    db,
    actor,
    experiment.id,
    'default',
    'Reviewed out-of-sample reports and sample-size limits',
  );
  const holdout = await queueValidation(
    db,
    actor,
    experiment.id,
    'default',
    'HOLDOUT',
  );
  expect((await executeReplay(db, holdout.id))!.metrics.closedTrades).toBe(1);
  await expect(
    selectVariant(
      db,
      actor,
      experiment.id,
      'without-be',
      'Change after seeing holdout',
    ),
  ).rejects.toThrow('cannot');
});

it('reconstructs confirmed break-even/trailing amendments and stop execution in event order', async () => {
  const input = replayFixture();
  const price = input.dataset.events.find((e) => e.kind === 'PRICE') as Extract<
    ReplayEvent,
    { kind: 'PRICE' }
  >;
  input.end = closeTime + 7000;
  input.dataset.events = [
    input.dataset.events[0]!,
    price,
    {
      ...price,
      tradeId: 'tighten',
      eventTime: closeTime + 3000,
      observedAt: closeTime + 3000,
      price: '201.3',
    },
    {
      ...price,
      tradeId: 'stop',
      eventTime: closeTime + 4000,
      observedAt: closeTime + 4000,
      price: '199.8',
    },
    {
      ...price,
      tradeId: 'stop-fill',
      eventTime: closeTime + 5000,
      observedAt: closeTime + 5000,
      price: '199.8',
    },
  ];
  const base = await run(input),
    recovery = structuredClone(input),
    buffer = recovery.dataset.events.slice(2);
  recovery.dataset.events = [
    ...recovery.dataset.events.slice(0, 2),
    {
      kind: 'GAP_START',
      id: 'amendment',
      marketKey: price.marketKey,
      observedAt: closeTime + 2500,
    },
    ...buffer,
    {
      kind: 'GAP_END',
      id: 'amendment',
      marketKey: price.marketKey,
      observedAt: closeTime + 6000,
      complete: true,
      evidenceHash: digest(buffer),
    },
  ];
  const replayed = await run(recovery);
  expect(replayed.report.trades).toEqual(base.report.trades);
  expect(replayed.report.trades[0]!.closeReason).toBe('STOP_LOSS');
  const amended = await pool.query(
    "SELECT count(*) FROM runtime_actions WHERE kind='AMEND_STOP'",
  );
  expect(Number(amended.rows[0].count)).toBeGreaterThanOrEqual(2);
});
it('reports NO_TRADE and expired unfilled entries without invented candle fills', async () => {
  const { strategyInput } = await import('../fixtures/strategies.js');
  const flat = strategyInput('mean-flat'),
    input = replayFixture();
  input.bots[0]!.strategy = 'mean-reversion';
  input.dataset.candles = Object.values(flat.candles).flatMap((c) => c!);
  input.dataset.events = [
    { kind: 'CANDLE', candle: flat.candles['5m']!.at(-1)! },
  ];
  expect((await run(input)).report.metrics.noTrade).toBe(1);
  const expired = replayFixture();
  expired.end = closeTime + 1801000;
  expired.dataset.events = [
    expired.dataset.events[0]!,
    { kind: 'TIMER', observedAt: expired.end },
  ];
  const result = await run(expired);
  expect(result.report.metrics.expired).toBe(1);
  expect(result.report.metrics.realizedNet).toBe('0');
});
it('does not claim a favorable close from an incomplete trade tape', async () => {
  const input = replayFixture();
  input.dataset.tradeCoverage = 'PARTIAL';
  const result = await run(input);
  expect(result.report.status).toBe('RECONCILIATION_UNCERTAIN');
  expect(result.report.metrics.filledTrades).toBe(0);
  expect(result.report.metrics.realizedNet).toBe('0');
});
it('persists a forward-feed disconnect and freezes an exposed PAPER bot when tick recovery cannot be certified', async () => {
  const { BotRepository } = await import('../../packages/database/src/bots.js'),
    { registerResearchStrategies } =
      await import('../../packages/database/src/strategies.js');
  const { PostgresRuntimeRepository, RuntimeControlRepository } =
    await import('../../packages/database/src/runtime.js');
  const { PostgresEvaluationRepository } =
    await import('../../packages/database/src/evaluations.js');
  const { PostgresCandleRepository } =
    await import('../../packages/database/src/market-data.js');
  const { PaperExecutionAdapter } =
    await import('../../packages/database/src/paper-execution.js');
  const { StrategyEngine } =
      await import('../../packages/strategies/src/engine.js'),
    { trendFollowing } =
      await import('../../packages/strategies/src/research.js');
  const { BotRuntime } =
      await import('../../packages/runtime/src/bot-runtime.js'),
    { PositionManager } =
      await import('../../packages/runtime/src/position-manager.js');
  const { RuntimeSupervisor } =
      await import('../../apps/runtime/src/supervisor.js'),
    { MarketDataService } =
      await import('../../packages/market-data/src/service.js');
  const { market, fixtureInstrument, VirtualClock, FakeMarketDataProvider } =
      await import('../fixtures/market.js'),
    { strategyInput } = await import('../fixtures/strategies.js'),
    { createLogger } = await import('../../packages/core/src/index.js');
  await pool.query('TRUNCATE market_instruments CASCADE');
  const registry = await registerResearchStrategies(db),
    version = registry.find((v) => v.slug === 'trend-following')!,
    clock = new VirtualClock(closeTime + 2000),
    store = new PostgresRuntimeRepository(db);
  const bot = await new BotRepository(db).create(
    actor,
    {
      name: 'Forward exposed',
      market,
      strategyVersionId: version.id,
      executionMode: 'PAPER',
      riskProfile: 'CONSERVATIVE',
      allocationTargetPercent: '20',
    },
    randomUUID(),
  );
  const lease = (await store.acquire(bot.id, randomUUID()))!,
    evaluations = new PostgresEvaluationRepository(db, lease),
    runtime = new BotRuntime(
      store,
      lease,
      new PaperExecutionAdapter(db, clock),
      trendFollowing,
      version.codeHash,
      evaluations,
      clock,
    );
  await new PostgresCandleRepository(db).saveInstrument(
    fixtureInstrument(market, clock.time),
  );
  const command = await new RuntimeControlRepository(db).enqueue(
    actor,
    bot.id,
    'START',
    randomUUID(),
    'Forward fixture',
    randomUUID(),
  );
  await runtime.command(command as never);
  await runtime.ready(true);
  await runtime.ready(true);
  const input = strategyInput('trend-long'),
    evaluation = await new StrategyEngine(evaluations).evaluate(
      trendFollowing,
      {
        ...input,
        botId: bot.id,
        accountId: bot.accountId,
        strategyVersionId: version.id,
        codeHash: version.codeHash,
      },
      randomUUID(),
    );
  await store.transact(lease, randomUUID(), clock.time, (v) => {
    const c = new PositionManager().entry(
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
      evaluation.id,
      structuredClone(trendFollowing.managementPolicy),
      clock.time,
    );
    c.view.trade!.executionBackend = 'PAPER';
    return c;
  });
  await runtime.reconcile();
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
    await supervisor.poll();
    await supervisor.poll();
    clock.advance(1000);
    feed.emit({
      kind: 'PRICE',
      marketKey: bot.canonicalMarketId,
      tradeId: 'forward-fill',
      eventTime: clock.time,
      observedAt: clock.time,
      price: '99.95',
      quantity: '0.2',
      reference: 'LAST',
      side: 'SELL',
    });
    for (let n = 0; n < 100; n++) {
      if ((await store.load(bot.id)).trade?.protectionStatus === 'CONFIRMED')
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await store.load(bot.id)).trade?.protectionStatus).toBe(
      'CONFIRMED',
    );
    clock.advance(1000);
    feed.emit({
      kind: 'STATUS',
      marketKey: bot.canonicalMarketId,
      state: 'DISCONNECTED',
      observedAt: clock.time,
    });
    clock.advance(1000);
    feed.emit({
      kind: 'STATUS',
      marketKey: bot.canonicalMarketId,
      state: 'CONNECTED',
      observedAt: clock.time,
    });
    feed.emit({
      kind: 'PRICE',
      marketKey: bot.canonicalMarketId,
      tradeId: 'unverified-gap-stop',
      eventTime: clock.time,
      observedAt: clock.time,
      price: '98',
      quantity: '100',
      reference: 'LAST',
      side: 'SELL',
    });
    await supervisor.close();
    const restored = await store.load(bot.id);
    expect(restored.fault).toBe('RECONCILIATION_UNCERTAIN');
    expect(restored.trading).toBe('UNRESOLVED');
    expect(Number(restored.trade!.closedQuantity)).toBe(0);
    expect(
      (
        await db
          .select()
          .from(recoveryGaps)
          .where(eq(recoveryGaps.botId, bot.id))
      )[0]!.status,
    ).toBe('UNCERTAIN');
    const recoveredLease = (await store.acquire(bot.id, randomUUID()))!;
    const stoppedRuntime = new BotRuntime(
      store,
      recoveredLease,
      new PaperExecutionAdapter(db, clock),
      trendFollowing,
      version.codeHash,
      new PostgresEvaluationRepository(db, recoveredLease),
      clock,
    );
    const stop = await new RuntimeControlRepository(db).enqueue(
      actor,
      bot.id,
      'STOP',
      randomUUID(),
      'Defer unknown cancellation',
      randomUUID(),
    );
    await stoppedRuntime.command(stop as never);
    const capacity = await pool.query(
      'SELECT reserved FROM paper_reservations WHERE bot_id=$1',
      [bot.id],
    );
    expect(Number(capacity.rows[0].reserved)).toBeGreaterThan(0);
    expect((await store.load(bot.id)).trading).toBe('UNRESOLVED');
    await store.release(recoveredLease);
  } finally {
    await supervisor.close();
    data.close();
    await data.drain();
  }
});
it('posts historical funding once, including after the position has closed, and fences stale owners', async () => {
  const result = await run(),
    [stored] = await db
      .select()
      .from(replayRuns)
      .where(eq(replayRuns.id, result.row.id)),
    [bot] = await db
      .select()
      .from(bots)
      .where(eq(bots.accountId, stored!.accountId!));
  const { PostgresRuntimeRepository } =
      await import('../../packages/database/src/runtime.js'),
    { postPaperFunding } =
      await import('../../packages/database/src/funding.js');
  const store = new PostgresRuntimeRepository(db),
    lease = (await store.acquire(bot!.id, randomUUID()))!,
    funding = replayFixture().dataset.events.find(
      (e) => e.kind === 'FUNDING',
    ) as Extract<ReplayEvent, { kind: 'FUNDING' }>;
  const before = await db
    .select()
    .from(capitalLedger)
    .where(eq(capitalLedger.botId, bot!.id));
  await postPaperFunding(db, lease, funding);
  await postPaperFunding(db, lease, funding);
  expect(
    await db
      .select()
      .from(capitalLedger)
      .where(eq(capitalLedger.botId, bot!.id)),
  ).toHaveLength(before.length);
  await store.release(lease);
  await expect(postPaperFunding(db, lease, funding)).rejects.toThrow('FENCED');
});
