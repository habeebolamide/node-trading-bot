/**
 * NO_TRADE recording (m6-predictions design.md — ambiguity resolution).
 *
 * The plan never says what happens when a TradeSetup is NO_TRADE. Two readings:
 *   A — no Prediction, veto recorded on the Signal    (chosen)
 *   B — a Prediction with null entry/horizon flagged NO_TRADE
 * §19 defines a Prediction as carrying an entry reference and a horizon; B would mean storing
 * rows null in the fields that define the entity, and every §32 metric would need a "taken only"
 * filter or silently report on a mixed population. So the veto goes here, and the R:R gate's own
 * accuracy becomes a separate M7 question against §18 shadow predictions.
 */
import { eq } from 'drizzle-orm';
import { signal, signalNoTrade, type Db } from '@tip/database';

export type NoTradeReason =
  | 'INSUFFICIENT_RR' | 'CANNOT_SIZE_SAFELY' | 'NO_STOP_DERIVABLE' | 'STALE_OR_MISSING_DATA';

/**
 * Record why the planner refused to trade this signal and mark the signal INVALIDATED (§36).
 * Idempotent by PK on signal_id; a re-vetoed signal keeps the first reason.
 */
export async function recordNoTrade(db: Db, input: { signalId: string; reason: NoTradeReason; detail?: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(signalNoTrade)
      .values({ signalId: input.signalId, reason: input.reason, detail: input.detail ?? null })
      .onConflictDoNothing();
    // Best-effort transition — if the signal isn't ACTIVE anymore the plan-level lifecycle is
    // already correct, and the veto record is what matters here.
    await tx.update(signal).set({ state: 'INVALIDATED' }).where(eq(signal.id, input.signalId));
  });
}
