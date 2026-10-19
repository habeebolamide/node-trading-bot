import { implementationHash } from '../packages/replay/src/runner.js';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  connectDatabase,
  recoveryGaps,
  bots,
  accounts,
  users,
} from '../packages/database/src/index.js';
import { PostgresRuntimeRepository } from '../packages/database/src/runtime.js';
import { PaperExecutionAdapter } from '../packages/database/src/paper-execution.js';
import { PostgresEvaluationRepository } from '../packages/database/src/evaluations.js';
import { BotRuntime } from '../packages/runtime/src/bot-runtime.js';
import { researchCatalog } from '../packages/strategies/src/catalog.js';
import {
  digest,
  replayEventSchema,
  VirtualClock,
  eventTime,
} from '../packages/replay/src/contracts.js';
import { replayGap } from '../packages/replay/src/recovery.js';
import {
  candleSchema,
  type Candle,
  type Timeframe,
} from '../packages/market-data/src/contracts.js';
import { postPaperFunding } from '../packages/database/src/funding.js';
const { values } = parseArgs({
  options: { file: { type: 'string' }, owner: { type: 'string' } },
});
if (!values.file || !values.owner || !process.env.DATABASE_URL)
  throw Error(
    'Usage: npm run recovery:replay -- --file /absolute/evidence.json --owner owner@email (stop the forward runtime first)',
  );
const input = z
  .object({
    gapId: z.uuid(),
    end: z.number().int(),
    complete: z.boolean(),
    evidenceHash: z.string().length(64),
    events: z.array(replayEventSchema),
    seedCandles: z.array(candleSchema),
  })
  .strict()
  .parse(JSON.parse(readFileSync(values.file, 'utf8')));
if (input.end > Date.now())
  throw Error('Recovery evidence cannot come from the future');
const { db, pool } = connectDatabase(process.env.DATABASE_URL),
  store = new PostgresRuntimeRepository(db);
let lease: Awaited<ReturnType<typeof store.acquire>> = null;
const renewal = setInterval(() => {
  if (lease) void store.renew(lease, 300000).catch(() => {});
}, 5000);
try {
  const [gap] = await db
    .select()
    .from(recoveryGaps)
    .where(eq(recoveryGaps.id, input.gapId));
  if (!gap) throw Error('Gap not found');
  const [bot] = await db.select().from(bots).where(eq(bots.id, gap.botId)),
    [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, bot!.accountId)),
    [owner] = await db
      .select()
      .from(users)
      .where(eq(users.email, values.owner));
  if (
    !owner ||
    account?.ownerUserId !== owner.id ||
    account.replayScope !== 'FORWARD'
  )
    throw Error('Owned forward PAPER account required');
  lease = await store.acquire(bot!.id, randomUUID(), 300000);
  if (!lease)
    throw Error(
      'Runtime still owns this bot; stop that process before offline recovery',
    );
  const view = await store.load(bot!.id),
    catalog = researchCatalog();
  const { strategyVersions, strategies } =
    await import('../packages/database/src/index.js');
  const [version] = await db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.id, bot!.strategyVersionId)),
    [strategy] = await db
      .select()
      .from(strategies)
      .where(eq(strategies.id, version!.strategyId));
  const selected = catalog.find(
    (s) =>
      s.definition.id === strategy?.slug &&
      s.definition.version === version?.version &&
      s.codeHash === version.codeHash,
  );
  if (!selected) throw Error('Installed strategy identity mismatch');
  const clock = new VirtualClock(gap.startTime),
    runtime = new BotRuntime(
      store,
      lease,
      new PaperExecutionAdapter(db, clock),
      selected.definition,
      selected.codeHash,
      new PostgresEvaluationRepository(db, lease),
      clock,
    );
  const dispatch = async (e: z.infer<typeof replayEventSchema>) => {
    const key =
      e.kind === 'CANDLE'
        ? e.candle.marketKey
        : 'marketKey' in e
          ? e.marketKey
          : null;
    if (key && key !== view.marketKey) throw Error('Wrong recovery market');
    if (e.kind === 'PRICE') {
      if (e.marketKey !== view.marketKey) throw Error('Wrong recovery market');
      await runtime.price(e);
    } else if (e.kind === 'CANDLE') {
      const series: Partial<Record<Timeframe, Candle[]>> = {};
      for (const candle of [
        ...input.seedCandles,
        ...input.events.filter((x) => x.kind === 'CANDLE').map((x) => x.candle),
      ])
        if (
          candle.marketKey === view.marketKey &&
          candle.observedAt <= eventTime(e) &&
          candle.closeTime <= e.candle.closeTime
        ) {
          const rows = (series[candle.timeframe] ??= []);
          if (!rows.some((c) => c.openTime === candle.openTime))
            rows.push(candle);
        }
      for (const rows of Object.values(series))
        rows!.sort((a, b) => a.openTime - b.openTime);
      for (const [frame, count] of Object.entries(
        selected.definition.requirements.minClosedCandlesByTimeframe,
      ))
        if ((series[frame as Timeframe]?.length ?? 0) < count!)
          throw Error(
            'Insufficient closed candle evidence for historical assessment',
          );
      await runtime.candle(
        {
          type: 'CANDLE_CLOSE',
          timeframe: e.candle.timeframe,
          eventTime: e.candle.closeTime,
          observedAt: e.candle.observedAt,
        },
        series,
        true,
      );
    } else if (e.kind === 'TIMER') await runtime.timer();
    else if (e.kind === 'FUNDING') await postPaperFunding(db, lease!, e);
  };
  console.log(
    JSON.stringify({
      gapId: gap.id,
      status: await replayGap({
        db,
        store,
        runtime,
        clock,
        gap,
        ...input,
        expectedHash: input.evidenceHash,
        contextHash: digest({
          engine: implementationHash(),
          seedCandles: input.seedCandles,
          codeHash: selected.codeHash,
          configVersion: view.configVersion,
        }),
        dispatch,
      }),
    }),
  );
} finally {
  clearInterval(renewal);
  if (lease) await store.release(lease);
  await pool.end();
}
