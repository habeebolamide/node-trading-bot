import { isDeepStrictEqual } from 'node:util';
import { paperPolicy, type RiskPolicy } from '../../risk/src/sizing.js';
import {
  approvePaperEntry,
  settlePaperChange,
  normalizePaperProtection,
  trackEquityPeaks,
} from './capital.js';
import { and, eq, inArray, asc, sql } from 'drizzle-orm';
import {
  accounts,
  bots,
  configs,
  runtimeLeases,
  runtimeCommands,
  tradeLifecycles,
  runtimeActions,
  runtimeCheckpoints,
  runtimeEvents,
  audits,
  strategyVersions,
  type Database,
} from './index.js';
import type {
  Action,
  Lease,
  RuntimeRepository,
  View,
  Trade,
  Change,
  CommandKind,
} from '../../runtime/src/contracts.js';
import type { Actor } from './bots.js';
import { DomainError } from '../../core/src/index.js';
const activeStates = ['PENDING_ENTRY', 'OPEN', 'CLOSING', 'UNRESOLVED'];
async function loadView(
  db: Pick<Database, 'select'>,
  botId: string,
): Promise<View> {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) throw Error('Bot not found');
  const [checkpoint] = await db
    .select()
    .from(runtimeCheckpoints)
    .where(eq(runtimeCheckpoints.botId, botId));
  const [trade] = await db
    .select()
    .from(tradeLifecycles)
    .where(
      and(
        eq(tradeLifecycles.botId, botId),
        inArray(tradeLifecycles.state, activeStates),
      ),
    );
  const actions = trade
    ? await db
        .select()
        .from(runtimeActions)
        .where(eq(runtimeActions.tradeId, trade.id))
    : [];
  return {
    botId,
    accountId: bot.accountId,
    market: bot.market as View['market'],
    marketKey: bot.canonicalMarketId,
    strategyVersionId: bot.strategyVersionId,
    configVersion: bot.configVersion,
    executionMode: bot.executionMode as View['executionMode'],
    operational: bot.operationalStatus as View['operational'],
    trading: bot.tradingState as View['trading'],
    desired: (checkpoint?.desired ??
      (bot.operationalStatus === 'STOPPED' ||
      bot.operationalStatus === 'STOP_REQUESTED'
        ? 'STOPPED'
        : bot.operationalStatus === 'PAUSED'
          ? 'PAUSED'
          : 'RUNNING')) as View['desired'],
    trade: (trade as Trade | undefined) ?? null,
    actions: actions as Action[],
    lastPriceTime: checkpoint?.lastPriceTime ?? 0,
    lastCandleTime: checkpoint?.lastCandleTime ?? 0,
    lastEvaluationId: checkpoint?.lastEvaluationId ?? null,
    fault: checkpoint?.fault ?? null,
  };
}
export class PostgresRuntimeRepository implements RuntimeRepository {
  constructor(
    private db: Database,
    private policy: RiskPolicy = paperPolicy,
  ) {}
  async acquire(
    botId: string,
    ownerId: string,
    ttlMs = 30000,
  ): Promise<Lease | null> {
    if (ttlMs < 50 || ttlMs > 300000) throw Error('Invalid lease TTL');
    const result = await this.db.execute<{
      bot_id: string;
      fencing_token: number;
    }>(
      sql`INSERT INTO runtime_leases(bot_id,owner_instance_id,fencing_token,expires_at) VALUES(${botId},${ownerId},1,clock_timestamp()+${ttlMs}*interval '1 millisecond') ON CONFLICT(bot_id) DO UPDATE SET owner_instance_id=excluded.owner_instance_id,fencing_token=CASE WHEN runtime_leases.owner_instance_id=excluded.owner_instance_id AND runtime_leases.expires_at>clock_timestamp() THEN runtime_leases.fencing_token ELSE runtime_leases.fencing_token+1 END,expires_at=excluded.expires_at WHERE runtime_leases.expires_at<=clock_timestamp() OR runtime_leases.owner_instance_id=excluded.owner_instance_id RETURNING bot_id,fencing_token`,
    );
    const row = result.rows[0];
    return row
      ? { botId: row.bot_id, ownerId, token: Number(row.fencing_token) }
      : null;
  }
  async renew(lease: Lease, ttlMs = 30000) {
    const rows = await this.db
      .update(runtimeLeases)
      .set({
        expiresAt: sql`clock_timestamp()+${ttlMs}*interval '1 millisecond'`,
      })
      .where(
        and(
          eq(runtimeLeases.botId, lease.botId),
          eq(runtimeLeases.ownerId, lease.ownerId),
          eq(runtimeLeases.token, lease.token),
          sql`${runtimeLeases.expiresAt}>clock_timestamp()`,
        ),
      )
      .returning();
    return rows.length === 1;
  }
  async release(lease: Lease) {
    await this.db
      .update(runtimeLeases)
      .set({ expiresAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(runtimeLeases.botId, lease.botId),
          eq(runtimeLeases.ownerId, lease.ownerId),
          eq(runtimeLeases.token, lease.token),
        ),
      );
  }
  load(botId: string) {
    return loadView(this.db, botId);
  }
  async transact(
    lease: Lease,
    key: string,
    eventTime: number,
    reduce: (view: View) => Change,
  ): Promise<View> {
    return this.db.transaction(async (tx) => {
      const [scope] = await tx
        .select()
        .from(bots)
        .where(eq(bots.id, lease.botId));
      if (!scope) throw Error('Bot not found');
      await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, scope.accountId))
        .for('update');
      const [owner] = await tx
        .select()
        .from(runtimeLeases)
        .where(
          and(
            eq(runtimeLeases.botId, lease.botId),
            eq(runtimeLeases.ownerId, lease.ownerId),
            eq(runtimeLeases.token, lease.token),
            sql`${runtimeLeases.expiresAt}>clock_timestamp()`,
          ),
        )
        .for('update');
      if (!owner) throw Error('FENCED: runtime lease expired or replaced');
      await tx.execute(
        sql`select set_config('platform.runtime_bot',${lease.botId},true),set_config('platform.runtime_owner',${lease.ownerId},true),set_config('platform.runtime_fence',${String(lease.token)},true)`,
      );
      const [bot] = await tx
        .select()
        .from(bots)
        .where(eq(bots.id, lease.botId))
        .for('update');
      if (!bot) throw Error('Bot not found');
      const previous = await loadView(tx, lease.botId);
      const [seen] = await tx
        .select({ id: runtimeEvents.id })
        .from(runtimeEvents)
        .where(
          and(eq(runtimeEvents.botId, lease.botId), eq(runtimeEvents.key, key)),
        );
      if (seen) return previous;
      const c = reduce(previous),
        v = c.view;
      if (
        v.botId !== previous.botId ||
        v.accountId !== previous.accountId ||
        v.strategyVersionId !== previous.strategyVersionId ||
        v.configVersion !== previous.configVersion
      )
        throw Error('Runtime cannot change bot identity or configuration');
      if (
        previous.trade?.executionBackend === 'PAPER' &&
        key.startsWith('report:')
      ) {
        const fact = await tx.execute<{ payload: unknown }>(
          sql`SELECT payload FROM paper_execution_reports WHERE bot_id=${lease.botId} AND event_key=${key.slice(7)}`,
        );
        const report = c.details.report as { kind?: string } | undefined;
        if (
          fact.rows[0]
            ? !isDeepStrictEqual(fact.rows[0].payload, report)
            : report?.kind !== 'UNKNOWN'
        )
          throw Error('PAPER_REPORT_EVIDENCE_MISMATCH');
      }
      const approval = await approvePaperEntry(
        tx,
        c,
        previous,
        eventTime,
        this.policy,
      );
      const current = c.view;
      // Risk rejection replaces the tentative view before anything becomes durable.
      Object.assign(v, current);
      await normalizePaperProtection(tx, c);
      const tradeChanged =
          JSON.stringify(v.trade) !== JSON.stringify(previous.trade),
        stateChanged =
          v.operational !== previous.operational ||
          v.trading !== previous.trading;
      if (v.trade && tradeChanged)
        await tx
          .insert(tradeLifecycles)
          .values(v.trade)
          .onConflictDoUpdate({ target: tradeLifecycles.id, set: v.trade });
      await settlePaperChange(tx, previous, c, key, eventTime, approval);
      if (v.trade?.executionBackend === 'PAPER')
        await trackEquityPeaks(tx, v.accountId, eventTime);
      for (const a of v.actions) {
        const old = previous.actions.find((x) => x.id === a.id);
        if (old && old.state !== a.state)
          await tx
            .update(runtimeActions)
            .set({ state: a.state })
            .where(eq(runtimeActions.id, a.id));
      }
      for (const a of c.actions)
        await tx.insert(runtimeActions).values(a).onConflictDoNothing();
      if (stateChanged)
        await tx
          .update(bots)
          .set({
            operationalStatus: v.operational,
            tradingState: v.trading,
            version: bot.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(bots.id, bot.id));
      await tx
        .insert(runtimeCheckpoints)
        .values({
          botId: v.botId,
          desired: v.desired,
          lastPriceTime: v.lastPriceTime,
          lastCandleTime: v.lastCandleTime,
          lastEvaluationId: v.lastEvaluationId,
          fault: v.fault,
          updatedAt: eventTime,
        })
        .onConflictDoUpdate({
          target: runtimeCheckpoints.botId,
          set: {
            desired: v.desired,
            lastPriceTime: v.lastPriceTime,
            lastCandleTime: v.lastCandleTime,
            lastEvaluationId: v.lastEvaluationId,
            fault: v.fault,
            updatedAt: eventTime,
          },
        });
      // Routine ticks advance the checkpoint; audit only transitions/protective actions, not every tick.
      if (
        !(
          key.startsWith('price:') ||
          c.kind === 'runtime.readiness' ||
          c.kind === 'trade.timer'
        ) ||
        tradeChanged ||
        stateChanged ||
        c.actions.length ||
        v.fault !== previous.fault
      )
        await tx.insert(runtimeEvents).values({
          botId: v.botId,
          key,
          kind: c.kind,
          eventTime,
          fencingToken: lease.token,
          details: {
            from: {
              operational: previous.operational,
              trading: previous.trading,
            },
            to: { operational: v.operational, trading: v.trading },
            actions: c.actions.map((a) => ({
              id: a.id,
              kind: a.kind,
              reason: a.reason,
            })),
            ...c.details,
          },
        });
      if (c.commandId)
        await tx
          .update(runtimeCommands)
          .set({
            status: c.commandError ? 'REJECTED' : 'APPLIED',
            completedAt: eventTime,
            result: {
              operational: v.operational,
              trading: v.trading,
              error: c.commandError ?? null,
            },
          })
          .where(
            and(
              eq(runtimeCommands.id, c.commandId),
              eq(runtimeCommands.botId, v.botId),
              eq(runtimeCommands.status, 'PENDING'),
            ),
          );
      return loadView(tx, lease.botId);
    });
  }
  async markSubmitting(
    lease: Lease,
    actionId: string,
    observedAt = Date.now(),
  ) {
    let submitted: Action | null = null;
    await this.transact(lease, `submit:${actionId}`, observedAt, (v) => {
      const view = structuredClone(v),
        action = view.actions.find((a) => a.id === actionId);
      if (action?.state === 'CREATED') {
        action.state = 'SUBMITTING';
        submitted = structuredClone(action);
      }
      return {
        view,
        actions: [],
        kind: 'execution.submitting',
        details: { actionId },
      };
    });
    return submitted;
  }
}
export class RuntimeControlRepository {
  constructor(private db: Database) {}
  async enqueue(
    actor: Actor,
    botId: string,
    kind: CommandKind,
    key: string,
    reason: string,
    correlationId: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [bot] = await tx
        .select()
        .from(bots)
        .where(eq(bots.id, botId))
        .for('update');
      if (!bot) throw new DomainError('BOT_NOT_FOUND', 'Bot not found', 404);
      const [config] = await tx
        .select()
        .from(configs)
        .where(
          and(
            eq(configs.botId, botId),
            eq(configs.configVersion, bot.configVersion),
          ),
        );
      // Resolve ownership through the account, never from a caller-supplied account ID.
      const [account] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, bot.accountId),
            eq(accounts.ownerUserId, actor.userId),
          ),
        );
      if (!account)
        throw new DomainError('BOT_NOT_FOUND', 'Bot not found', 404);
      if (actor.role !== 'OWNER')
        throw new DomainError('FORBIDDEN', 'Owner permission required', 403);
      const [existing] = await tx
        .select()
        .from(runtimeCommands)
        .where(
          and(
            eq(runtimeCommands.botId, botId),
            eq(runtimeCommands.idempotencyKey, key),
          ),
        );
      if (existing) {
        if (existing.kind !== kind || existing.reason !== reason)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'Command key was used with different content',
            409,
          );
        return existing;
      }
      if (!config) throw Error('Missing bot configuration');
      if (kind === 'START') {
        const [strategy] = await tx
          .select()
          .from(strategyVersions)
          .where(eq(strategyVersions.id, bot.strategyVersionId));
        if (
          !strategy?.codeHash ||
          (strategy.requirements as { implemented?: boolean }).implemented !==
            true
        )
          throw new DomainError(
            'STRATEGY_UNIMPLEMENTED',
            'Starting requires an implemented research strategy version',
            409,
          );
      }
      const [command] = await tx
        .insert(runtimeCommands)
        .values({
          botId,
          accountId: account.id,
          actorId: actor.userId,
          kind,
          idempotencyKey: key,
          reason,
          correlationId,
          requestedAt: Date.now(),
        })
        .returning();
      if (!command) throw Error('Command insertion failed');
      await tx.insert(audits).values({
        accountId: account.id,
        botId,
        actorId: actor.userId,
        eventType: 'runtime.command_requested',
        correlationId,
        details: { commandId: command.id, kind, reason },
      });
      return command;
    });
  }
  async pending(botId: string) {
    return this.db
      .select()
      .from(runtimeCommands)
      .where(
        and(
          eq(runtimeCommands.botId, botId),
          eq(runtimeCommands.status, 'PENDING'),
        ),
      )
      .orderBy(asc(runtimeCommands.sequence));
  }
}
