import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import request from 'supertest';
import {
  connectDatabase,
  users,
  accounts,
  tokens,
} from '../../packages/database/src/index.js';
import { migrateDatabase } from '../../packages/database/src/migrate.js';
import { registerResearchStrategies } from '../../packages/database/src/strategies.js';
import { BotRepository, type Actor } from '../../packages/database/src/bots.js';
import {
  PostgresRuntimeRepository,
  RuntimeControlRepository,
} from '../../packages/database/src/runtime.js';
import { PostgresEvaluationRepository } from '../../packages/database/src/evaluations.js';
import { DurableFakeExecutionAdapter } from '../../packages/database/src/fake-execution.js';
import { BotRuntime } from '../../packages/runtime/src/bot-runtime.js';
import { StrategyEngine } from '../../packages/strategies/src/engine.js';
import { trendFollowing } from '../../packages/strategies/src/research.js';
import { strategyInput } from '../fixtures/strategies.js';
import { market } from '../fixtures/market.js';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger } from '../../packages/core/src/index.js';
import {
  projectNotifications,
  savePreferences,
  updateIncident,
  deliverOne,
  expireFinalAttempts,
} from '../../packages/notifications/src/service.js';
try {
  loadEnvFile('.env');
} catch {}
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Dedicated test DB required');
const { pool, db } = connectDatabase(url),
  repo = new BotRepository(db),
  store = new PostgresRuntimeRepository(db);
let actor: Actor,
  accountId: string,
  token: string,
  viewer: string,
  foreign: string,
  version: { id: string; codeHash: string },
  bots: Awaited<ReturnType<BotRepository['create']>>[];
async function issue(user: string, role: 'OWNER' | 'VIEWER') {
  const raw = randomBytes(32).toString('base64url');
  await db.insert(tokens).values({
    userId: user,
    role,
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    expiresAt: new Date(Date.now() + 120000),
  });
  return raw;
}
beforeAll(() => migrateDatabase(url));
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query(
    'TRUNCATE market_instruments,audit_events,bot_config_versions,coin_ownership,bots,api_tokens,exchange_accounts,strategy_versions,strategies,app_users,notification_worker_health CASCADE',
  );
  const [owner] = await db
    .insert(users)
    .values({ email: 'notifications@test.local' })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ ownerUserId: owner!.id, name: 'Test paper' })
    .returning();
  actor = { userId: owner!.id, role: 'OWNER' };
  accountId = account!.id;
  const [other] = await db
    .insert(users)
    .values({ email: 'foreign@test.local' })
    .returning();
  await db.insert(accounts).values({ ownerUserId: other!.id, name: 'Other' });
  token = await issue(owner!.id, 'OWNER');
  viewer = await issue(owner!.id, 'VIEWER');
  foreign = await issue(other!.id, 'OWNER');
  version = (await registerResearchStrategies(db)).find(
    (v) => v.slug === 'trend-following',
  )!;
  bots = [];
  for (const coin of ['BTC', 'ETH', 'SOL'])
    bots.push(
      await repo.create(
        actor,
        {
          name: `${coin} paper`,
          market: { ...market, baseAsset: coin },
          strategyVersionId: version.id,
          executionMode: 'PAPER',
          riskProfile: 'CONSERVATIVE',
          allocationTargetPercent: '20',
        },
        randomUUID(),
      ),
    );
  await savePreferences(pool, accountId, actor.userId, {
    botId: null,
    enabled: true,
    recipientRef: '123456',
    events: ['ENTRY', 'EXIT', 'PROTECTION', 'RECOVERY'],
  });
});
async function startAll() {
  for (const b of bots) {
    const lease = (await store.acquire(b.id, randomUUID()))!;
    const runtime = new BotRuntime(
      store,
      lease,
      new DurableFakeExecutionAdapter(db),
      trendFollowing,
      version.codeHash,
      new PostgresEvaluationRepository(db, lease),
    );
    const c = await new RuntimeControlRepository(db).enqueue(
      actor,
      b.id,
      'START',
      randomUUID(),
      'Test startup',
      randomUUID(),
    );
    await runtime.command(c as never);
    await runtime.ready(true);
    await runtime.ready(true);
  }
}
it('groups a shared three-bot outage, persists across restart and permits resolution only after fresh recovery checks', async () => {
  await startAll();
  await projectNotifications(pool);
  await projectNotifications(pool);
  let incidents = await pool.query('SELECT * FROM system_incidents');
  expect(incidents.rowCount).toBe(1);
  const incident = incidents.rows[0];
  expect(incident.affected_bots).toHaveLength(3);
  expect((await pool.query('SELECT * FROM notification_outbox')).rowCount).toBe(
    1,
  );
  const restarted = connectDatabase(url!);
  try {
    await projectNotifications(restarted.pool);
    expect(
      (await restarted.pool.query('SELECT * FROM notification_outbox'))
        .rowCount,
    ).toBe(1);
  } finally {
    await restarted.pool.end();
  }
  await updateIncident(
    pool,
    accountId,
    actor.userId,
    incident.id,
    'ACKNOWLEDGED',
    'Seen by operator',
  );
  expect((await store.load(bots[0]!.id)).operational).toBe('RUNNING');
  await expect(
    updateIncident(
      pool,
      accountId,
      actor.userId,
      incident.id,
      'RESOLVED',
      'Not actually fixed',
    ),
  ).rejects.toMatchObject({ code: 'FAULT_ACTIVE' });
  const { PostgresCandleRepository } =
    await import('../../packages/database/src/market-data.js');
  const { fixtureInstrument } = await import('../fixtures/market.js');
  for (const b of bots) {
    await new PostgresCandleRepository(db).saveInstrument(
      fixtureInstrument(b.market as typeof market, Date.now()),
    );
    const instrument = (
      await pool.query(
        'SELECT id FROM market_instruments WHERE canonical_market_id=$1',
        [b.canonicalMarketId],
      )
    ).rows[0];
    await pool.query(
      'INSERT INTO market_checkpoints(stream_key,instrument_id,observed_at,state) VALUES($1,$2,$3,$4)',
      [
        b.canonicalMarketId + ':health',
        instrument.id,
        Date.now(),
        JSON.stringify({
          marketKey: b.canonicalMarketId,
          canEvaluate: true,
          state: 'READY',
        }),
      ],
    );
  }
  await projectNotifications(pool);
  expect(
    (await pool.query('SELECT status FROM system_incidents')).rows[0].status,
  ).toBe('RECOVERING');
  await updateIncident(
    pool,
    accountId,
    actor.userId,
    incident.id,
    'RESOLVED',
    'Fresh feed and no unresolved recovery gaps',
  );
  expect(
    (await pool.query('SELECT status FROM system_incidents')).rows[0].status,
  ).toBe('RESOLVED');
  expect((await pool.query('SELECT * FROM incident_events')).rowCount).toBe(4);
  await expect(pool.query('DELETE FROM incident_events')).rejects.toMatchObject(
    { code: '23514' },
  );
});
it('stores 100 NO_TRADE evaluations and projects zero individual Telegram notifications', async () => {
  const b = bots[0]!,
    engine = new StrategyEngine(new PostgresEvaluationRepository(db));
  const lease = (await store.acquire(b.id, randomUUID()))!;
  for (let i = 0; i < 100; i++) {
    const input = strategyInput('trend-flat');
    input.trigger.eventTime += i * 900000;
    input.trigger.observedAt += i * 900000;
    const e = await engine.evaluate(
      trendFollowing,
      {
        ...input,
        botId: b.id,
        accountId,
        strategyVersionId: version.id,
        configVersion: 1,
        codeHash: version.codeHash,
      },
      randomUUID(),
    );
    expect(e.decision).toBe('NO_TRADE');
    await store.transact(
      lease,
      `evaluated:${e.id}`,
      input.trigger.observedAt,
      (v) => ({
        view: v,
        actions: [],
        kind: 'strategy.evaluated',
        details: { evaluationId: e.id, decision: e.decision },
      }),
    );
  }
  await projectNotifications(pool);
  await projectNotifications(pool);
  expect(
    (await pool.query('SELECT * FROM strategy_evaluations')).rowCount,
  ).toBe(100);
  expect((await pool.query('SELECT * FROM notification_outbox')).rowCount).toBe(
    0,
  );
});
it('bounds hanging sends, respects 429, dead-letters failures and fences competing deliveries', async () => {
  await startAll();
  await projectNotifications(pool);
  const hanging = deliverOne(pool, () => new Promise(() => {}), 30);
  await new Promise((r) => setTimeout(r, 5));
  expect(
    await deliverOne(pool, async () => ({ messageId: 'should not run' })),
  ).toBe(false);
  await hanging;
  let row = (await pool.query('SELECT * FROM notification_outbox')).rows[0];
  expect(row.status).toBe('PENDING');
  expect(row.last_error).toBe('TIMEOUT');
  await pool.query('UPDATE notification_outbox SET available_at=now()');
  await deliverOne(pool, async () => ({
    error: 'RATE_LIMIT',
    retryAfter: 120,
  }));
  row = (await pool.query('SELECT * FROM notification_outbox')).rows[0];
  expect(new Date(row.available_at).getTime() - Date.now()).toBeGreaterThan(
    115000,
  );
  for (let i = 0; i < 3; i++) {
    await pool.query('UPDATE notification_outbox SET available_at=now()');
    await deliverOne(pool, async () => ({ error: 'UNAVAILABLE' }));
  }
  row = (await pool.query('SELECT * FROM notification_outbox')).rows[0];
  expect(row.status).toBe('DEAD');
  expect(row.attempt_count).toBe(5);
  expect(
    (await pool.query('SELECT * FROM notification_attempts')).rowCount,
  ).toBe(5);
  expect(
    await deliverOne(pool, async () => ({ messageId: 'no sixth send' })),
  ).toBe(false);
});
it('reclaims a crashed lease, retains dedupe and handles the final unknown send conservatively', async () => {
  await startAll();
  await projectNotifications(pool);
  await pool.query(
    `UPDATE notification_outbox SET status='SENDING',lease_token=$1,lease_until=now()-interval '1 second',attempt_count=1`,
    [randomUUID()],
  );
  await deliverOne(pool, async () => ({ messageId: '42' }));
  let row = (await pool.query('SELECT * FROM notification_outbox')).rows[0];
  expect(row.status).toBe('SENT');
  expect(row.attempt_count).toBe(2);
  await projectNotifications(pool);
  expect((await pool.query('SELECT * FROM notification_outbox')).rowCount).toBe(
    1,
  );
  await pool.query(
    `UPDATE notification_outbox SET status='SENDING',lease_until=now()-interval '1 second',attempt_count=5`,
  );
  await expireFinalAttempts(pool);
  row = (await pool.query('SELECT * FROM notification_outbox')).rows[0];
  expect(row.status).toBe('DEAD');
  expect(row.last_error).toBe('DELIVERY_UNKNOWN');
});
it('scopes incidents, preferences, reports and audit to the bearer account; viewers cannot mutate', async () => {
  await startAll();
  await projectNotifications(pool);
  const app = createApp(db, pool, createLogger('test', 'silent')),
    auth = (t: string) => `Bearer ${t}`;
  for (const path of [
    '/incidents',
    '/notifications/preferences',
    '/notifications/delivery-status',
    '/account/report',
    '/audit-events',
  ]) {
    await request(app)
      .get('/api' + path)
      .expect(401);
    await request(app)
      .get('/api' + path)
      .set('Authorization', auth(viewer))
      .expect(200);
  }
  const foreignIncidents = await request(app)
    .get('/api/incidents')
    .set('Authorization', auth(foreign))
    .expect(200);
  expect(foreignIncidents.body.data).toEqual([]);
  const incident = (await pool.query('SELECT id FROM system_incidents'))
    .rows[0];
  await request(app)
    .get(`/api/incidents/${incident.id}`)
    .set('Authorization', auth(foreign))
    .expect(404);
  await request(app)
    .post(`/api/incidents/${incident.id}/acknowledge`)
    .set('Authorization', auth(viewer))
    .send({ reason: 'Viewer' })
    .expect(403);
  await request(app)
    .patch('/api/notifications/preferences')
    .set('Authorization', auth(foreign))
    .send({ botId: bots[0]!.id, enabled: true, recipientRef: '1', events: [] })
    .expect(404);
  await request(app)
    .patch('/api/notifications/preferences')
    .set('Authorization', auth(viewer))
    .send({ enabled: false, recipientRef: null, events: [] })
    .expect(403);
  await request(app)
    .post(`/api/incidents/${incident.id}/acknowledge`)
    .set('Authorization', auth(token))
    .send({ reason: 'Investigating' })
    .expect(200);
  await request(app)
    .post(`/api/incidents/${incident.id}/resolve`)
    .set('Authorization', auth(token))
    .send({ reason: 'Premature' })
    .expect(409);
  const report = await request(app)
    .get('/api/account/report')
    .set('Authorization', auth(token))
    .expect(200);
  expect(report.body.data.simulated).toBe(true);
});
