import { eq, sql } from 'drizzle-orm';
import { recoveryGaps, type Database } from '../../database/src/index.js';
import { PostgresRuntimeRepository } from '../../database/src/runtime.js';
import { BotRuntime } from '../../runtime/src/bot-runtime.js';
import {
  digest,
  eventTime,
  VirtualClock,
  type ReplayEvent,
} from './contracts.js';
import type { Lease, View } from '../../runtime/src/contracts.js';
export async function recordGap(
  db: Database,
  store: PostgresRuntimeRepository,
  lease: Lease,
  key: string,
  start: number,
  end: number | null = null,
) {
  await store.transact(lease, `gap-open:${key}`, start, (v) => {
    const baseline = {
      operational: v.operational,
      trading: v.trading,
      fault: v.fault,
      filled: v.trade?.filledQuantity,
      closed: v.trade?.closedQuantity,
      tradeState: v.trade?.state,
      protectionStatus: v.trade?.protectionStatus,
    };
    if (v.trade) {
      v.trade.state = 'UNRESOLVED';
      v.trade.protectionStatus = 'UNKNOWN';
      v.trading = 'UNRESOLVED';
      v.fault = 'RECONCILIATION_UNCERTAIN';
    }
    return {
      view: {
        ...v,
        operational: v.operational === 'STOPPED' ? 'STOPPED' : 'RECONCILING',
      },
      actions: [],
      kind: 'recovery.gap_open',
      details: {
        recoveryGap: {
          key: `${lease.botId}:${key}`,
          startTime: start,
          endTime: end,
          coverage: { baseline },
        },
      },
    };
  });
  return (
    await db
      .select()
      .from(recoveryGaps)
      .where(eq(recoveryGaps.key, `${lease.botId}:${key}`))
  )[0]!;
}

export async function markUncertain(
  store: PostgresRuntimeRepository,
  lease: Lease,
  key: string,
  now: number,
) {
  await store.transact(lease, `uncertain:${key}`, now, (v) => {
    if (v.trade) {
      v.trade.state = 'UNRESOLVED';
      v.trade.protectionStatus = 'UNKNOWN';
      v.trading = 'UNRESOLVED';
    }
    if (v.operational !== 'STOPPED') v.operational = 'RECONCILING';
    v.fault = 'RECONCILIATION_UNCERTAIN';
    return {
      view: v,
      actions: [],
      kind: 'recovery.uncertain',
      details: { reason: 'RECONCILIATION_UNCERTAIN', gap: key },
    };
  });
}
export async function updateGap(
  db: Database,
  lease: Lease,
  id: string,
  set: Partial<typeof recoveryGaps.$inferInsert>,
) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('platform.runtime_bot',${lease.botId},true),set_config('platform.runtime_owner',${lease.ownerId},true),set_config('platform.runtime_fence',${String(lease.token)},true)`,
    );
    await tx.update(recoveryGaps).set(set).where(eq(recoveryGaps.id, id));
  });
}
export async function replayGap(options: {
  db: Database;
  store: PostgresRuntimeRepository;
  runtime: BotRuntime;
  clock: VirtualClock;
  gap: typeof recoveryGaps.$inferSelect;
  events: ReplayEvent[];
  end: number;
  complete: boolean;
  expectedHash?: string;
  contextHash: string;
  dispatch: (e: ReplayEvent) => Promise<void>;
}) {
  const { db, store, runtime, clock, gap, events, end, dispatch } = options,
    lease = runtime.lease;
  if (gap.status === 'RESOLVED') return 'RESOLVED';
  runtime.freeze();
  const pinned = gap.coverage as {
    evidenceHash?: string;
    contextHash?: string;
  };
  if (
    gap.checkpoint >= 0 &&
    (pinned.evidenceHash !== options.expectedHash ||
      pinned.contextHash !== options.contextHash)
  )
    throw Error('Applied recovery evidence is immutable');
  let previous = gap.startTime;
  let previousPrice = gap.startTime;
  let priorSequence: number | undefined;
  const valid =
    end >= gap.startTime &&
    end >= (gap.endTime ?? gap.startTime) &&
    events.every((e) => {
      const t = eventTime(e);
      const priceOrdered =
        e.kind !== 'PRICE' ||
        (e.eventTime >= previousPrice &&
          e.eventTime <= e.observedAt &&
          (e.eventTime !== previousPrice ||
            (e.sequence !== undefined &&
              priorSequence !== undefined &&
              e.sequence > priorSequence)));
      if (e.kind === 'PRICE') {
        previousPrice = e.eventTime;
        priorSequence = e.sequence;
      }
      const okay =
        priceOrdered && t >= previous && t >= gap.startTime && t <= end;
      previous = t;
      return okay && !(e.kind === 'GAP_START' || e.kind === 'GAP_END');
    });
  if (
    !options.complete ||
    !valid ||
    !options.expectedHash ||
    options.expectedHash !== digest(events)
  ) {
    await markUncertain(store, lease, gap.id, end);
    await updateGap(db, lease, gap.id, {
      status: 'UNCERTAIN',
      endTime: Math.max(end, gap.startTime, gap.endTime ?? 0),
      coverage: {
        ...(gap.coverage as object),
        reason: 'Incomplete ordered event evidence',
        evidenceHash: digest(events),
      },
    });
    return 'UNCERTAIN';
  }
  const coverage = gap.coverage as {
    baseline: {
      filled?: string;
      closed?: string;
      fault: string | null;
      trading: View['trading'];
      tradeState: NonNullable<View['trade']>['state'];
      protectionStatus: NonNullable<View['trade']>['protectionStatus'];
    };
    evidenceHash?: string;
  };
  if (
    coverage.baseline.fault ||
    (coverage.evidenceHash &&
      gap.status === 'REPLAYING' &&
      coverage.evidenceHash !== options.expectedHash)
  )
    throw Error('Recovery baseline or evidence changed');
  await updateGap(db, lease, gap.id, {
    status: 'REPLAYING',
    endTime: end,
    coverage: {
      ...coverage,
      evidenceHash: options.expectedHash,
      contextHash: options.contextHash,
      events,
    },
  });
  if (gap.checkpoint < 0)
    await store.transact(
      lease,
      `recovery-restore:${gap.id}`,
      gap.startTime,
      (v) => {
        if (v.fault && v.fault !== 'RECONCILIATION_UNCERTAIN')
          throw Error('Independent execution fault requires reconciliation');
        if (
          v.trade &&
          (v.trade.filledQuantity !== coverage.baseline.filled ||
            v.trade.closedQuantity !== coverage.baseline.closed)
        )
          throw Error('Recovery exposure differs from captured baseline');
        v.fault = null;
        if (v.trade) {
          v.trade.state = coverage.baseline.tradeState;
          v.trade.protectionStatus = coverage.baseline.protectionStatus;
          v.trading = coverage.baseline.trading;
        }
        return {
          view: v,
          actions: [],
          kind: 'recovery.replay_started',
          details: { gap: gap.id },
        };
      },
    );
  const saved = clock.time;
  try {
    for (let n = gap.checkpoint + 1; n < events.length; n++) {
      clock.time = eventTime(events[n]!);
      await dispatch(events[n]!);
      await updateGap(db, lease, gap.id, { checkpoint: n });
    }
    clock.time = end;
    await runtime.timer();
    await runtime.reconcile();
    const desired = (await store.load(lease.botId)).desired;
    if (desired !== 'RUNNING')
      await runtime.command({
        id: gap.id,
        kind: desired === 'STOPPED' ? 'STOP' : 'PAUSE',
        requestedAt: end,
      });
    await updateGap(db, lease, gap.id, { status: 'RESOLVED' });
    await runtime.ready(true);
    await runtime.ready(true);
    runtime.allowEntries();
    return 'RESOLVED';
  } finally {
    clock.time = saved;
  }
}
