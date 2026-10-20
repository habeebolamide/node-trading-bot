import type { Clock } from '../../core/src/index.js';
import { systemClock } from '../../core/src/index.js';
import type {
  StrategyDefinition,
  EvaluationInput,
  EvaluationRepository,
  StrategyTrigger,
} from '../../strategies/src/contracts.js';
import { StrategyEngine } from '../../strategies/src/engine.js';
import { buildContext } from '../../strategies/src/context.js';
import {
  durations,
  type Candle,
  type Timeframe,
} from '../../market-data/src/contracts.js';
import { PositionManager, openQuantity } from './position-manager.js';
import type {
  RuntimeRepository,
  ExecutionAdapter,
  Lease,
  Price,
  Report,
  View,
  Command,
} from './contracts.js';
export class BotRuntime {
  private acceptingEntries = true;
  allowEntries() {
    this.acceptingEntries = true;
  }
  freeze() {
    this.acceptingEntries = false;
  }
  private tail: Promise<unknown> = Promise.resolve();
  private manager = new PositionManager();
  private engine: StrategyEngine;
  constructor(
    private store: RuntimeRepository,
    readonly lease: Lease,
    private adapter: ExecutionAdapter,
    private strategy: StrategyDefinition,
    private codeHash: string,
    evaluations: EvaluationRepository,
    private clock: Clock = systemClock,
    private entryPermission: () => boolean = () => true,
  ) {
    this.engine = new StrategyEngine(evaluations);
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const task = this.tail.then(run);
    this.tail = task.catch(() => {});
    return task;
  }
  drain() {
    return this.tail;
  }
  private now() {
    return this.clock.now().getTime();
  }
  async restore() {
    return this.serial(async () => {
      await this.store.transact(
        this.lease,
        `restore:${this.lease.token}`,
        this.now(),
        (v) => this.manager.restore(v),
      );
      await this.reconcileInternal();
      return this.store.load(this.lease.botId);
    });
  }
  command(command: Command) {
    return this.serial(async () => {
      const v = await this.store.transact(
        this.lease,
        `command:${command.id}`,
        this.now(),
        (v) => {
          const c = this.manager.command(v, command, this.now());
          if (v.fault === 'RECONCILIATION_UNCERTAIN') {
            c.actions = [];
            c.view.actions = v.actions;
            c.view.trade = v.trade;
            c.view.trading = v.trading;
            c.details = {
              ...c.details,
              controlsDeferred: 'RECOVERY_EVIDENCE_REQUIRED',
            };
          }
          return c;
        },
      );
      await this.pump();
      return this.store.load(v.botId);
    });
  }
  async protectAndFreeze() {
    this.freeze();
    return this.serial(async () => {
      await this.store.transact(
        this.lease,
        `safety:freeze:${crypto.randomUUID()}`,
        this.now(),
        (v) => {
          if (v.desired !== 'RUNNING')
            return {
              view: v,
              actions: [],
              kind: 'safety.already_frozen',
              details: {},
            };
          const c = this.manager.command(
            v,
            { id: crypto.randomUUID(), kind: 'PAUSE', requestedAt: this.now() },
            this.now(),
          );
          delete c.commandId;
          if (v.fault === 'RECONCILIATION_UNCERTAIN') {
            c.actions = [];
            c.view.actions = v.actions;
            c.view.trade = v.trade;
            c.view.trading = v.trading;
          }
          c.kind = 'safety.protect_and_freeze';
          c.details = {
            policy: 'PROTECT_AND_FREEZE',
            reason: 'NEW_PAPER_ENTRIES_DISABLED',
          };
          return c;
        },
      );
      await this.pump();
    });
  }
  ready(healthy: boolean) {
    return this.serial(async () => {
      await this.store.transact(
        this.lease,
        `ready:${crypto.randomUUID()}`,
        this.now(),
        (v) => {
          const c = this.manager.readiness(v, healthy, this.now());
          if (
            c.view.operational === 'RUNNING' &&
            v.operational !== 'RUNNING' &&
            this.strategy.requirements.trigger === 'CANDLE_CLOSE'
          )
            c.view.lastCandleTime = Math.max(
              v.lastCandleTime,
              Math.floor(
                this.now() /
                  durations[this.strategy.requirements.primaryTimeframe],
              ) * durations[this.strategy.requirements.primaryTimeframe],
            );
          return c;
        },
      );
      await this.pump();
      return this.store.load(this.lease.botId);
    });
  }
  timer() {
    return this.serial(async () => {
      const now = this.now();
      if (
        (await this.store.load(this.lease.botId)).fault ===
        'RECONCILIATION_UNCERTAIN'
      )
        return;
      await this.store.transact(this.lease, `timer:${now}`, now, (v) => {
        const c = this.manager.timer(v, now);
        if (
          v.trade?.openedAt &&
          v.trade.policy.timeExit.enabled &&
          this.strategy.requirements.trigger === 'CANDLE_CLOSE' &&
          now - v.trade.openedAt >=
            durations[this.strategy.requirements.primaryTimeframe] *
              v.trade.policy.timeExit.maxHoldingCandles
        ) {
          const timed = this.manager.close(c.view, 'MAX_HOLDING_TIME', now);
          timed.actions = [...c.actions, ...timed.actions];
          return timed;
        }
        return c;
      });
      await this.pump();
    });
  }
  price(event: Price) {
    return this.serial(async () => {
      if (event.eventTime > event.observedAt || event.observedAt > this.now())
        return;
      if (
        (await this.store.load(this.lease.botId)).fault ===
        'RECONCILIATION_UNCERTAIN'
      )
        return;
      if (this.adapter.onPrice) {
        for (const report of await this.adapter.onPrice(event, this.lease))
          await this.apply(report);
        await this.pump();
      }
      const view = await this.store.load(this.lease.botId);
      if (!view.trade || openQuantity(view.trade).lte(0)) return;
      await this.store.transact(
        this.lease,
        `price:${event.tradeId}`,
        event.observedAt,
        (v) => this.manager.price(v, event),
      );
      await this.pump();
    });
  }
  candle(
    trigger: StrategyTrigger,
    candles: Partial<Record<Timeframe, Candle[]>>,
    healthy: boolean,
  ) {
    return this.serial(async () => {
      let view = await this.store.load(this.lease.botId);
      if (
        trigger.observedAt > this.now() ||
        trigger.eventTime > trigger.observedAt ||
        view.fault === 'RECONCILIATION_UNCERTAIN' ||
        trigger.type !== 'CANDLE_CLOSE' ||
        this.strategy.requirements.trigger !== 'CANDLE_CLOSE' ||
        trigger.timeframe !== this.strategy.requirements.primaryTimeframe ||
        trigger.eventTime <= view.lastCandleTime
      )
        return;
      const input: EvaluationInput = {
        botId: view.botId,
        accountId: view.accountId,
        strategyVersionId: view.strategyVersionId,
        configVersion: view.configVersion,
        market: view.market,
        codeHash: this.codeHash,
        trigger,
        tradingState: view.trading,
        dataHealthy: healthy,
        candles,
      };
      if (view.trade) {
        const context = buildContext(this.strategy, input),
          trade = view.trade;
        if (!trade.entryTerminal) {
          const pending = this.strategy.evaluatePendingEntry(context, {
            id: trade.id,
            marketKey: view.marketKey,
            side: trade.side,
            createdAt: trade.createdAt,
            expiresAt: trade.expiresAt,
            entryPrice: trade.entryReference,
            stopLoss: trade.initialStop,
          });
          if (pending.action === 'CANCEL')
            await this.store.transact(
              this.lease,
              `pending:${trigger.eventTime}`,
              trigger.observedAt,
              (v) =>
                this.manager.pendingInvalidated(
                  v,
                  pending.reason,
                  trigger.observedAt,
                ),
            );
        }
        view = await this.store.load(view.botId);
        if (
          view.trade &&
          openQuantity(view.trade).gt(0) &&
          view.trade.confirmedStop !== null
        ) {
          const t = view.trade;
          const assessment = this.strategy.evaluatePosition(context, {
            id: t.id,
            marketKey: view.marketKey,
            side: t.side,
            openedAt: t.openedAt!,
            quantity: openQuantity(t).toFixed(),
            entryPrice: t.averageEntry!,
            initialStop: t.initialStop,
            confirmedStop: t.confirmedStop!,
          });
          await this.store.transact(
            this.lease,
            `assessment:${trigger.eventTime}`,
            trigger.observedAt,
            (v) =>
              this.manager.assessment(
                v,
                { context, assessment },
                trigger.observedAt,
              ),
          );
        }
      } else if (
        this.acceptingEntries &&
        this.entryPermission() &&
        view.operational === 'RUNNING' &&
        view.trading === 'IDLE'
      ) {
        const evaluation = await this.engine.evaluate(
          this.strategy,
          input,
          crypto.randomUUID(),
        );
        if (evaluation.snapshot.decision.action === 'PROPOSE_ENTRY')
          await this.store.transact(
            this.lease,
            `evaluation:${evaluation.id}`,
            trigger.observedAt,
            (v) => {
              if (!this.acceptingEntries || !this.entryPermission())
                return {
                  view: v,
                  actions: [],
                  kind: 'safety.entry_frozen',
                  details: {
                    evaluationId: evaluation.id,
                    reason: 'PROTECT_AND_FREEZE',
                  },
                };
              const change = this.manager.entry(
                v,
                evaluation.snapshot.decision as Extract<
                  typeof evaluation.snapshot.decision,
                  { action: 'PROPOSE_ENTRY' }
                >,
                evaluation.id,
                structuredClone(this.strategy.managementPolicy),
                trigger.observedAt,
                evaluation.snapshot.context.indicators.atr?.latest.outReal,
              );
              if (change.view.trade)
                change.view.trade.executionBackend = this.adapter.backend;
              return change;
            },
          );
        await this.store.transact(
          this.lease,
          `evaluated:${evaluation.id}`,
          trigger.observedAt,
          (v) => ({
            view: { ...v, lastEvaluationId: evaluation.id },
            actions: [],
            kind: 'strategy.evaluated',
            details: {
              evaluationId: evaluation.id,
              decision: evaluation.decision,
            },
          }),
        );
      }
      await this.store.transact(
        this.lease,
        `candle:${trigger.timeframe}:${trigger.eventTime}`,
        trigger.observedAt,
        (v) => ({
          view: { ...v, lastCandleTime: trigger.eventTime },
          actions: [],
          kind: 'runtime.candle_checkpoint',
          details: {},
        }),
      );
      await this.pump();
    });
  }
  report(report: Report) {
    return this.serial(async () => {
      await this.apply(report);
      await this.pump();
    });
  }
  reconcile() {
    return this.serial(() => this.reconcileInternal());
  }
  private async apply(report: Report) {
    await this.store.transact(
      this.lease,
      `report:${report.eventId}`,
      report.eventTime,
      (v) => this.manager.report(v, report, this.now()),
    );
  }
  private async reconcileInternal() {
    const reports = await this.adapter.reconcile(this.lease.botId);
    for (const report of reports) await this.apply(report);
    const view = await this.store.load(this.lease.botId);
    for (const a of view.actions.filter((a) => a.state === 'SUBMITTING'))
      await this.apply({
        eventId: `unresolved:${a.id}`,
        botId: a.botId,
        tradeId: a.tradeId,
        actionId: a.id,
        kind: 'UNKNOWN',
        eventTime: this.now(),
      });
    await this.pump();
  }
  private async pump() {
    for (let cycle = 0; cycle < 100; cycle++) {
      const view = await this.store.load(this.lease.botId),
        next = view.actions.find(
          (a) =>
            a.state === 'CREATED' &&
            (a.kind !== 'ENTRY' ||
              (this.acceptingEntries && this.entryPermission())),
        );
      if (!next) return;
      const action = await this.store.markSubmitting(
        this.lease,
        next.id,
        this.now(),
      );
      if (!action) continue;
      if (
        action.kind === 'ENTRY' &&
        (!this.acceptingEntries || !this.entryPermission())
      ) {
        await this.apply({
          eventId: `freeze-before-submit:${action.id}`,
          actionId: action.id,
          tradeId: action.tradeId,
          botId: action.botId,
          kind: 'UNKNOWN',
          eventTime: this.now(),
        });
        return;
      }
      // The committed intent and fencing authorization precede this adapter boundary. No SQL lock spans it.
      let reports: Report[];
      try {
        reports = await this.adapter.submit(action, this.lease);
      } catch {
        reports = [
          {
            eventId: `timeout:${action.id}`,
            actionId: action.id,
            tradeId: action.tradeId,
            botId: action.botId,
            kind: 'UNKNOWN',
            eventTime: this.now(),
          },
        ];
      }
      for (const report of reports) await this.apply(report);
    }
    throw Error('Execution action loop exceeded bounded work limit');
  }
}
