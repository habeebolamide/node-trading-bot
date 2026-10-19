import { riskPolicyFromEnv } from '../../../packages/risk/src/sizing.js';
import { systemClock, type Clock } from '../../../packages/core/src/index.js';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  bots,
  strategies,
  strategyVersions,
  type Database,
} from '../../../packages/database/src/index.js';
import {
  PostgresRuntimeRepository,
  RuntimeControlRepository,
} from '../../../packages/database/src/runtime.js';
import { PostgresEvaluationRepository } from '../../../packages/database/src/evaluations.js';
import { DurableFakeExecutionAdapter } from '../../../packages/database/src/fake-execution.js';
import { PaperExecutionAdapter } from '../../../packages/database/src/paper-execution.js';
import { PostgresCandleRepository } from '../../../packages/database/src/market-data.js';
import { researchCatalog } from '../../../packages/strategies/src/catalog.js';
import { requiredHistory } from '../../../packages/market-data/src/indicators.js';
import {
  durations,
  type Candle,
  type DataRequirements,
  type Timeframe,
} from '../../../packages/market-data/src/contracts.js';
import type { MarketDataService } from '../../../packages/market-data/src/service.js';
import type {
  Command,
  Lease,
} from '../../../packages/runtime/src/contracts.js';
import { BotRuntime } from '../../../packages/runtime/src/bot-runtime.js';
export class RuntimeSupervisor {
  private ownerId = randomUUID();
  private store: PostgresRuntimeRepository;
  private controls: RuntimeControlRepository;
  private candles: PostgresCandleRepository;
  private handles = new Map<
    string,
    {
      runtime: BotRuntime;
      lease: Lease;
      legacy: boolean;
      remove: () => void;
      definition: ReturnType<typeof researchCatalog>[number]['definition'];
    }
  >();
  private busy = false;
  private stopping = false;
  constructor(
    private db: Database,
    private data: MarketDataService,
    private log: Logger,
    private clock: Clock = systemClock,
  ) {
    this.store = new PostgresRuntimeRepository(db, riskPolicyFromEnv());
    this.controls = new RuntimeControlRepository(db);
    this.candles = new PostgresCandleRepository(db);
  }
  async poll() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const candidates = await this.db
        .select()
        .from(bots)
        .where(
          sql`${bots.operationalStatus} NOT IN ('STOPPED','ERROR') OR ${bots.tradingState}<>'IDLE' OR EXISTS(SELECT 1 FROM runtime_commands c WHERE c.bot_id=${bots.id} AND c.status='PENDING')`,
        );
      for (const bot of candidates) {
        if (this.stopping) break;
        try {
          let handle = this.handles.get(bot.id);
          if (handle && !(await this.store.renew(handle.lease))) {
            handle.remove();
            this.handles.delete(bot.id);
            handle = undefined;
          }
          if (!handle) {
            const lease = await this.store.acquire(bot.id, this.ownerId);
            if (!lease) continue;
            const [registered] = await this.db
              .select()
              .from(strategyVersions)
              .where(eq(strategyVersions.id, bot.strategyVersionId));
            const catalog = researchCatalog();
            const [identity] = registered
              ? await this.db
                  .select()
                  .from(strategies)
                  .where(eq(strategies.id, registered.strategyId))
              : [];
            const selected = catalog.find(
              (e) =>
                e.definition.id === identity?.slug &&
                e.definition.version === registered?.version &&
                e.codeHash === registered.codeHash,
            );
            if (!selected) {
              await this.store.transact(
                lease,
                `unavailable:${lease.token}`,
                this.clock.now().getTime(),
                (v) => ({
                  view: {
                    ...v,
                    operational: 'ERROR',
                    fault: 'STRATEGY_CODE_UNAVAILABLE',
                  },
                  actions: [],
                  kind: 'runtime.code_unavailable',
                  details: {},
                }),
              );
              for (const command of await this.controls.pending(bot.id))
                await this.store.transact(
                  lease,
                  `reject:${command.id}`,
                  this.clock.now().getTime(),
                  (v) => ({
                    view: v,
                    actions: [],
                    kind: 'command.rejected',
                    details: { error: 'STRATEGY_CODE_UNAVAILABLE' },
                    commandId: command.id,
                    commandError: 'STRATEGY_CODE_UNAVAILABLE',
                  }),
                );
              await this.store.release(lease);
              continue;
            }
            const legacy =
              (await this.store.load(bot.id)).trade?.executionBackend ===
              'FAKE_CONTRACT';
            const runtime = new BotRuntime(
              this.store,
              lease,
              legacy
                ? new DurableFakeExecutionAdapter(this.db, {}, this.clock)
                : new PaperExecutionAdapter(this.db, this.clock),
              selected.definition,
              selected.codeHash,
              new PostgresEvaluationRepository(this.db, lease),
              this.clock,
            );
            if (legacy) runtime.freeze();
            await runtime.restore();
            const req = this.requirements(selected.definition);
            const price = await this.data.onPrice(
              bot.market as never,
              req,
              (e) => {
                void runtime.price(e).catch((error) =>
                  this.log.warn(
                    {
                      botId: bot.id,
                      code: String(error).includes('FENCED')
                        ? 'FENCED'
                        : 'PRICE_HANDLER_FAILED',
                    },
                    'position monitor could not commit',
                  ),
                );
              },
            );
            const candle = await this.data.onCandle(
              bot.market as never,
              req,
              (c) => {
                if (
                  selected.definition.requirements.trigger === 'CANDLE_CLOSE' &&
                  c.timeframe ===
                    selected.definition.requirements.primaryTimeframe
                )
                  void this.onCandle(
                    runtime,
                    selected.definition,
                    c.closeTime,
                    c.observedAt,
                  ).catch(() =>
                    this.log.warn(
                      { botId: bot.id },
                      'candle dispatch failed; no new execution assumed',
                    ),
                  );
              },
            );
            handle = {
              runtime,
              lease,
              legacy,
              remove: () => {
                price();
                candle();
              },
              definition: selected.definition,
            };
            this.handles.set(bot.id, handle);
          }
          for (const command of await this.controls.pending(bot.id))
            await handle.runtime.command(command as Command);
          await handle.runtime.reconcile();
          const view = await this.store.load(bot.id);
          if (
            (view.operational === 'STOPPED' && view.trading === 'IDLE') ||
            (handle.legacy && !view.trade)
          ) {
            handle.remove();
            await this.store.release(handle.lease);
            this.handles.delete(bot.id);
            continue;
          }
          const health = await this.data.seed(
            view.market,
            this.requirements(handle.definition),
          );
          await handle.runtime.ready(health.canEvaluate);
          await handle.runtime.timer();
        } catch (error) {
          this.log.warn(
            {
              botId: bot.id,
              code: String(error).includes('FENCED')
                ? 'FENCED'
                : 'RUNTIME_DEGRADED',
            },
            'runtime reconciliation/readiness failed; new entries remain gated',
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }
  private requirements(
    definition: ReturnType<typeof researchCatalog>[number]['definition'],
  ): DataRequirements {
    return {
      minClosedCandlesByTimeframe: {
        ...definition.requirements.minClosedCandlesByTimeframe,
      },
      indicators: definition.requirements.indicators.map((i) => ({
        ...i,
        parameters: { ...i.parameters },
      })),
    };
  }
  private async onCandle(
    runtime: BotRuntime,
    definition: ReturnType<typeof researchCatalog>[number]['definition'],
    cutoff: number,
    observedAt: number,
  ) {
    if (this.stopping || definition.requirements.trigger !== 'CANDLE_CLOSE')
      return;
    const view = await this.store.load(runtime.lease.botId),
      counts = requiredHistory(this.requirements(definition)),
      candles: Partial<Record<Timeframe, Candle[]>> = {};
    for (const [frame, count] of Object.entries(counts) as [
      Timeframe,
      number,
    ][]) {
      const end = Math.floor(cutoff / durations[frame]) * durations[frame];
      candles[frame] = await this.candles.read(
        view.marketKey,
        frame,
        end - count * durations[frame],
        end,
        Math.max(observedAt, this.clock.now().getTime()),
      );
    }
    await runtime.candle(
      {
        type: 'CANDLE_CLOSE',
        timeframe: definition.requirements.primaryTimeframe,
        eventTime: cutoff,
        observedAt: Math.max(observedAt, this.clock.now().getTime()),
      },
      candles,
      this.data.health(view.marketKey)?.canEvaluate === true,
    );
  }
  health() {
    return {
      backend: 'PAPER',
      ownedBots: this.handles.size,
      acceptsPaperOrders: true,
    };
  }
  async renew() {
    for (const [id, h] of this.handles) {
      if (!(await this.store.renew(h.lease))) {
        h.runtime.freeze();
        h.remove();
        this.handles.delete(id);
      }
    }
  }
  async close() {
    this.stopping = true;
    for (const h of this.handles.values()) h.runtime.freeze();
    for (const h of this.handles.values()) h.remove();
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 10));
    for (const h of this.handles.values()) {
      await h.runtime.drain();
      await this.store.release(h.lease);
    }
    this.handles.clear();
  }
}
