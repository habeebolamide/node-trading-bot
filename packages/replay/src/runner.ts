import { inWindow } from './experiments.js';
import { requiredHistory } from '../../market-data/src/indicators.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { eq, and, sql } from 'drizzle-orm';
import {
  users,
  accounts,
  bots,
  replayRuns,
  replayInstruments,
  replaySamples,
  strategies,
  strategyVersions,
  recoveryGaps,
  capitalReservations,
  type Database,
} from '../../database/src/index.js';
import { BotRepository, type Actor } from '../../database/src/bots.js';
import { registerResearchStrategies } from '../../database/src/strategies.js';
import {
  PostgresRuntimeRepository,
  RuntimeControlRepository,
} from '../../database/src/runtime.js';
import { PostgresEvaluationRepository } from '../../database/src/evaluations.js';
import { PaperExecutionAdapter } from '../../database/src/paper-execution.js';
import { postPaperFunding } from '../../database/src/funding.js';
import { capitalSnapshot } from '../../database/src/capital.js';
import { BotRuntime } from '../../runtime/src/bot-runtime.js';
import { researchCatalog } from '../../strategies/src/catalog.js';
import {
  durations,
  type Candle,
  type Timeframe,
} from '../../market-data/src/contracts.js';
import type { Lease } from '../../runtime/src/contracts.js';
import { FinancialDecimal as D } from '../../core/src/decimal.js';
import { marketKey, DomainError } from '../../core/src/index.js';
import { money } from '../../risk/src/sizing.js';
import {
  parseInput,
  digest,
  eventTime,
  seededFraction,
  VirtualClock,
  type ReplayInput,
  type ReplayEvent,
} from './contracts.js';
import { recordGap, replayGap, markUncertain, updateGap } from './recovery.js';
import { replayReport } from './report.js';
export function implementationHash() {
  return digest([
    readdirSync(new URL('../../database/migrations', import.meta.url))
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        readFileSync(
          new URL('../../database/migrations/' + name, import.meta.url),
          'utf8',
        ),
      ),
    [
      '../../core/src/decimal.ts',
      '../../database/src/runtime.ts',
      '../../database/src/evaluations.ts',
      '../../database/src/fake-execution.ts',
      '../../database/src/schema.ts',
      '../../market-data/src/contracts.ts',
      './runner.ts',
      './validation.ts',
      './experiments.ts',
      './generator.ts',
      './contracts.ts',
      './recovery.ts',
      './report.ts',
      './equity.ts',
      '../../runtime/src/bot-runtime.ts',
      '../../runtime/src/position-manager.ts',
      '../../database/src/paper-execution.ts',
      '../../database/src/capital.ts',
      '../../database/src/funding.ts',
      '../../risk/src/sizing.ts',
    ].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')),
  ]);
}
export async function enqueueReplay(
  db: Pick<Database, 'insert'>,
  actor: Actor,
  raw: unknown,
  metadata: {
    experimentId?: string;
    stage?: string;
    variant?: string;
    windowIndex?: number;
  } = {},
) {
  if (actor.role !== 'OWNER')
    throw new DomainError('FORBIDDEN', 'Owner permission required', 403);
  let config: ReplayInput;
  try {
    config = parseInput(raw);
  } catch (error) {
    throw new DomainError(
      'INVALID_BACKTEST_INPUT',
      String(error instanceof Error ? error.message : error),
      400,
    );
  }
  const manifest = {
    engine: implementationHash(),
    strategies: researchCatalog().map((c) => ({
      id: c.definition.id,
      version: c.definition.version,
      codeHash: c.codeHash,
    })),
    execution: 'public-trade-participation-v1',
  };
  const [run] = await db
    .insert(replayRuns)
    .values({
      ...metadata,
      ownerUserId: actor.userId,
      input: { config, manifest },
      inputHash: digest({ config, manifest }),
    })
    .returning();
  return run!;
}
export async function readReplay(db: Database, actor: Actor, id: string) {
  const [run] = await db
    .select()
    .from(replayRuns)
    .where(
      and(eq(replayRuns.id, id), eq(replayRuns.ownerUserId, actor.userId)),
    );
  if (!run)
    throw new DomainError('BACKTEST_NOT_FOUND', 'Backtest not found', 404);
  return run;
}
export async function executeReplay(
  db: Database,
  id: string,
  options: {
    signal?: AbortSignal;
    afterEvent?: (index: number) => Promise<void>;
    afterDispatch?: (index: number) => Promise<void>;
  } = {},
) {
  const owner = randomUUID();
  const claim = await db.execute<{ id: string }>(
    sql`UPDATE replay_runs SET status='RUNNING',lease_owner=${owner},lease_until=clock_timestamp()+interval '30 seconds' WHERE id=${id} AND status IN ('QUEUED','RUNNING') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING id`,
  );
  if (!claim.rows.length) return null;
  const [run] = await db.select().from(replayRuns).where(eq(replayRuns.id, id));
  const { config: raw, manifest } = run!.input as {
    config: ReplayInput;
    manifest: { engine: string };
  };
  const input = parseInput(raw),
    clock = new VirtualClock(input.start - 1),
    store = new PostgresRuntimeRepository(db, input.policy),
    controls = new RuntimeControlRepository(db);
  const handles: {
    key: string;
    marketKey: string;
    runtime: BotRuntime;
    lease: Lease;
    definition: ReturnType<typeof researchCatalog>[number]['definition'];
  }[] = [];
  let accountId = run!.accountId;
  const heartbeat = setInterval(() => {
    void db
      .execute(
        sql`UPDATE replay_runs SET lease_until=clock_timestamp()+interval '30 seconds' WHERE id=${id} AND lease_owner=${owner} AND status='RUNNING'`,
      )
      .catch(() => {});
    for (const h of handles) void store.renew(h.lease).catch(() => {});
  }, 5000);
  try {
    if (manifest.engine !== implementationHash())
      throw Error('Installed replay implementation differs from pinned run');
    if (!accountId) {
      accountId = await db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ email: `replay-${id}@simulation.invalid` })
          .onConflictDoNothing()
          .returning();
        if (!user) throw Error('Partial replay setup requires investigation');
        const [account] = await tx
          .insert(accounts)
          .values({
            ownerUserId: user.id,
            name: `Replay ${id}`,
            replayScope: id,
            equityBaseline: input.equityBaseline,
          })
          .returning();
        await tx
          .update(replayRuns)
          .set({ accountId: account!.id })
          .where(eq(replayRuns.id, id));
        return account!.id;
      });
    }
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (account?.replayScope !== id)
      throw Error('Replay account isolation violated');
    const actor: Actor = { userId: account.ownerUserId, role: 'OWNER' },
      repo = new BotRepository(db),
      registry = await registerResearchStrategies(db),
      catalog = researchCatalog();
    for (const config of input.bots) {
      const installed = catalog.find(
        (c) => c.definition.id === config.strategy,
      )!;
      const policy = {
        ...structuredClone(installed.definition.managementPolicy),
        ...config.management,
      };
      const definition = {
        ...installed.definition,
        managementPolicy: policy,
        version: config.management
          ? `${installed.definition.version}+replay.${digest(policy).slice(0, 12)}`
          : installed.definition.version,
      };
      let versionId = registry.find((r) => r.slug === config.strategy)!.id;
      const codeHash = config.management
        ? digest({ base: installed.codeHash, policy })
        : installed.codeHash;
      if (config.management) {
        const [strategy] = await db
          .select()
          .from(strategies)
          .where(eq(strategies.slug, config.strategy));
        const requirements = {
          ...definition.requirements,
          implemented: true,
          validationStatus: 'RESEARCH_UNVALIDATED',
          preset: definition.preset,
          parameters: definition.parameters,
          managementPolicy: policy,
        };
        await db
          .insert(strategyVersions)
          .values({
            strategyId: strategy!.id,
            version: definition.version,
            codeHash,
            requirements,
            status: 'DRAFT',
          })
          .onConflictDoNothing();
        const [v] = await db
          .select()
          .from(strategyVersions)
          .where(
            and(
              eq(strategyVersions.strategyId, strategy!.id),
              eq(strategyVersions.version, definition.version),
            ),
          );
        if (v?.codeHash !== codeHash)
          throw Error('Strategy variant identity conflict');
        versionId = v.id;
      }
      let [bot] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.accountId, accountId), eq(bots.name, config.key)));
      if (!bot)
        bot = await repo.create(
          actor,
          {
            name: config.key,
            market: config.market,
            strategyVersionId: versionId,
            executionMode: 'PAPER',
            riskProfile: config.riskProfile,
            allocationTargetPercent: config.allocationTargetPercent,
          },
          randomUUID(),
        );
      const instrument = input.dataset.instruments.find(
        (i) => i.marketKey === marketKey(config.market),
      );
      if (!instrument) throw Error('Missing dataset instrument');
      let snapshot = instrument;
      if (input.dataset.instrumentHistory === 'CURRENT_ASSUMPTION')
        snapshot = {
          ...instrument,
          verifiedAt: input.start - 1,
          expiresAt: input.end + 1,
          raw: {
            ...instrument.raw,
            replayAssumption: true,
            originalVerifiedAt: instrument.verifiedAt,
          },
        };
      if (snapshot.verifiedAt > input.start || snapshot.expiresAt < input.end)
        throw Error('Instrument history does not cover replay window');
      await db
        .insert(replayInstruments)
        .values({
          key: `${accountId}:${bot.canonicalMarketId}`,
          accountId,
          marketKey: bot.canonicalMarketId,
          snapshot,
        })
        .onConflictDoNothing();
      const lease = await store.acquire(bot.id, owner);
      if (!lease) throw Error('REPLAY_BOT_BUSY');
      const runtime = new BotRuntime(
        store,
        lease,
        new PaperExecutionAdapter(db, clock),
        definition,
        codeHash,
        new PostgresEvaluationRepository(db, lease),
        clock,
      );
      handles.push({
        key: config.key,
        marketKey: bot.canonicalMarketId,
        runtime,
        lease,
        definition,
      });
      if (bot.operationalStatus === 'STOPPED') {
        const command = await controls.enqueue(
          actor,
          bot.id,
          'START',
          digest([id, config.key]).slice(0, 8) +
            '-0000-4000-8000-' +
            digest([id, config.key]).slice(8, 20),
          'Replay start',
          randomUUID(),
        );
        await runtime.command(command as never);
        await runtime.ready(true);
        await runtime.ready(true);
      } else {
        const latest = await db.execute<{ time: string | null }>(
          sql`SELECT max((payload->>'eventTime')::bigint)::text AS time FROM paper_execution_reports WHERE bot_id=${bot.id}`,
        );
        clock.time = Math.max(
          clock.time,
          Number(latest.rows[0]?.time ?? clock.time),
        );
        await runtime.reconcile();
        if (run!.checkpoint < 0) {
          await runtime.ready(true);
          await runtime.ready(true);
        }
      }
    }
    const limits = new Map(
      handles.map((h) => [
        h.marketKey,
        requiredHistory({
          minClosedCandlesByTimeframe: {
            ...h.definition.requirements.minClosedCandlesByTimeframe,
          },
          indicators: h.definition.requirements.indicators.map((i) => ({
            ...i,
            parameters: { ...i.parameters },
          })),
        }),
      ]),
    );
    const indexed = new Map<string, Map<Timeframe, Candle[]>>(),
      identities = new Map<string, Candle>();
    for (const candle of [
      ...input.dataset.candles,
      ...input.dataset.events
        .filter(
          (e): e is Extract<ReplayEvent, { kind: 'CANDLE' }> =>
            e.kind === 'CANDLE',
        )
        .map((e) => e.candle),
    ]) {
      const key = `${candle.marketKey}:${candle.timeframe}:${candle.openTime}`,
        old = identities.get(key);
      if (old) {
        if (digest(old) !== digest(candle))
          throw Error('Conflicting replay candle');
        continue;
      }
      identities.set(key, candle);
      const frames =
        indexed.get(candle.marketKey) ?? new Map<Timeframe, Candle[]>();
      indexed.set(candle.marketKey, frames);
      const values = frames.get(candle.timeframe) ?? [];
      frames.set(candle.timeframe, values);
      values.push(candle);
    }
    for (const frames of indexed.values())
      for (const values of frames.values())
        values.sort((a, b) => a.closeTime - b.closeTime);
    const bars = (market: string, time: number) => {
      const result: Partial<Record<Timeframe, Candle[]>> = {};
      for (const [frame, values] of indexed.get(market) ?? []) {
        let lo = 0,
          hi = values.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (values[mid]!.closeTime <= time) lo = mid + 1;
          else hi = mid;
        }
        const selected: Candle[] = [];
        for (
          let n = lo - 1;
          n >= 0 && selected.length < (limits.get(market)?.[frame] ?? 500);
          n--
        ) {
          const candle = values[n]!;
          if (candle.observedAt <= time && candle.availableAt <= time)
            selected.push(candle);
        }
        result[frame] = selected.reverse();
      }
      return result;
    };
    const dispatch = async (h: (typeof handles)[number], e: ReplayEvent) => {
      if (e.kind === 'PRICE') {
        if (input.dataset.tradeCoverage !== 'COMPLETE_ORDERED') {
          const view = await store.load(h.lease.botId);
          if (view.trade) {
            const gap = await recordGap(
              db,
              store,
              h.lease,
              `partial:${e.tradeId}`,
              Math.max(view.lastPriceTime, view.trade.createdAt),
              eventTime(e),
            );
            await markUncertain(store, h.lease, gap.id, eventTime(e));
            await updateGap(db, h.lease, gap.id, {
              status: 'UNCERTAIN',
              coverage: {
                ...(gap.coverage as object),
                reason: 'Incomplete source trade coverage',
              },
            });
            return;
          }
        }

        const factor =
          input.liquidity.model === 'SEEDED_PARTICIPATION'
            ? input.liquidity.minimumFactor +
              (1 - input.liquidity.minimumFactor) *
                seededFraction(input.seed, `${e.marketKey}:${e.tradeId}`)
            : 1;
        await h.runtime.price({
          ...e,
          quantity: money(new D(e.quantity).mul(factor)),
        });
      } else if (e.kind === 'CANDLE') {
        const view = await store.load(h.lease.botId),
          t = view.trade;
        if (t && input.dataset.tradeCoverage !== 'COMPLETE_ORDERED') {
          const low = new D(e.candle.low),
            high = new D(e.candle.high);
          if (
            (!t.entryTerminal &&
              low.lte(t.entryReference) &&
              high.gte(t.entryReference)) ||
            (new D(t.filledQuantity).gt(t.closedQuantity) &&
              (t.side === 'LONG'
                ? low.lte(t.confirmedStop ?? t.initialStop) ||
                  high.gte(t.takeProfit)
                : high.gte(t.confirmedStop ?? t.initialStop) ||
                  low.lte(t.takeProfit)))
          ) {
            const gap = await recordGap(
              db,
              store,
              h.lease,
              `bar:${e.candle.timeframe}:${e.candle.openTime}`,
              e.candle.openTime,
              e.candle.closeTime,
            );
            await markUncertain(store, h.lease, gap.id, eventTime(e));
            await updateGap(db, h.lease, gap.id, {
              status: 'UNCERTAIN',
              coverage: {
                ...(gap.coverage as object),
                reason: 'OHLCV cannot establish execution/TP/SL order',
              },
            });
            return;
          }
        }
        await h.runtime.candle(
          {
            type: 'CANDLE_CLOSE',
            timeframe: e.candle.timeframe,
            eventTime: e.candle.closeTime,
            observedAt: e.candle.observedAt,
          },
          bars(h.marketKey, e.candle.observedAt),
          true,
        );
      } else if (e.kind === 'FUNDING') await postPaperFunding(db, h.lease, e);
      else if (e.kind === 'TIMER') await h.runtime.timer();
    };
    for (let n = run!.checkpoint + 1; n < input.dataset.events.length; n++) {
      if (options.signal?.aborted) return null;
      const e = input.dataset.events[n]!,
        time = eventTime(e);
      if (time < input.start) continue;
      if (!inWindow(time, { start: input.start, end: input.end })) break;
      clock.time = time;
      for (const h of handles) {
        const key =
          e.kind === 'CANDLE'
            ? e.candle.marketKey
            : 'marketKey' in e
              ? e.marketKey
              : null;
        if (key && key !== h.marketKey) continue;
        const gaps = await db
            .select()
            .from(recoveryGaps)
            .where(eq(recoveryGaps.botId, h.lease.botId)),
          active = gaps.find((g) => g.status !== 'RESOLVED');
        if (e.kind === 'GAP_START') {
          h.runtime.freeze();
          await recordGap(db, store, h.lease, e.id, e.observedAt);
          continue;
        }
        if (e.kind === 'GAP_END') {
          const gap = gaps.find((g) => g.key === `${h.lease.botId}:${e.id}`);
          if (!gap) throw Error('Gap end without start');
          const events = input.dataset.events
            .slice(0, n)
            .filter(
              (x) =>
                eventTime(x) >= gap.startTime &&
                eventTime(x) <= time &&
                x.kind !== 'GAP_START' &&
                x.kind !== 'GAP_END' &&
                (x.kind === 'CANDLE'
                  ? x.candle.marketKey === h.marketKey
                  : !('marketKey' in x) || x.marketKey === h.marketKey),
            );
          await replayGap({
            db,
            store,
            runtime: h.runtime,
            clock,
            gap,
            events,
            end: time,
            complete: e.complete,
            expectedHash: e.evidenceHash,
            contextHash: run!.inputHash,
            dispatch: (x) => dispatch(h, x),
          });
          continue;
        }
        if (active) continue;
        await dispatch(h, e);
      }
      await options.afterDispatch?.(n);
      if (options.signal?.aborted) return null;
      const balances = await capitalSnapshot(db, accountId, time),
        reservations = await db
          .select()
          .from(capitalReservations)
          .where(eq(capitalReservations.accountId, accountId));
      const equity = balances.reduce(
        (sum, b) =>
          sum.plus(new D(b.balance).minus(b.principal)).plus(b.unrealized),
        new D(input.equityBaseline),
      );
      await db.transaction(async (tx) => {
        const owned = await tx.execute(
          sql`SELECT id FROM replay_runs WHERE id=${id} AND lease_owner=${owner} AND lease_until>clock_timestamp() FOR UPDATE`,
        );
        if (!owned.rows.length) throw Error('FENCED: replay worker expired');
        await tx
          .insert(replaySamples)
          .values({
            key: `${id}:${n}`,
            runId: id,
            ordinal: n,
            eventTime: time,
            equity: money(equity),
            capacity: money(
              reservations.reduce(
                (s, r) => s.plus(r.reserved).plus(r.committed),
                new D(0),
              ),
            ),
          })
          .onConflictDoNothing();
        await tx
          .update(replayRuns)
          .set({ checkpoint: n })
          .where(eq(replayRuns.id, id));
      });
      await options.afterEvent?.(n);
    }
    clock.time = input.end - 1;
    for (const h of handles) {
      const unresolved = await db
        .select()
        .from(recoveryGaps)
        .where(eq(recoveryGaps.botId, h.lease.botId));
      if (!unresolved.some((g) => g.status !== 'RESOLVED'))
        await h.runtime.timer();
    }
    const report = await replayReport(db, id, accountId, input, run!.inputHash);
    await db
      .update(replayRuns)
      .set({
        status: report.status === 'COMPLETE' ? 'COMPLETED' : 'UNCERTAIN',
        report,
        leaseUntil: null,
      })
      .where(and(eq(replayRuns.id, id), eq(replayRuns.leaseOwner, owner)));
    return report;
  } catch (error) {
    if (error instanceof Error && error.message === 'REPLAY_BOT_BUSY')
      return null;
    await db
      .update(replayRuns)
      .set({
        status: 'FAILED',
        error: String(error instanceof Error ? error.message : error),
        leaseUntil: null,
      })
      .where(and(eq(replayRuns.id, id), eq(replayRuns.leaseOwner, owner)));
    throw error;
  } finally {
    clearInterval(heartbeat);
    for (const h of handles) await store.release(h.lease);
    await db
      .update(replayRuns)
      .set({ leaseUntil: null })
      .where(
        and(
          eq(replayRuns.id, id),
          eq(replayRuns.leaseOwner, owner),
          eq(replayRuns.status, 'RUNNING'),
        ),
      );
  }
}
