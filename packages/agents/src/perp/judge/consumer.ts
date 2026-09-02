/**
 * Override-gate consumer (§18). Subscribes `judge.evaluation.completed`, joins the Signal +
 * Judge's signal_feature row, computes the §18 decision, and:
 *   AGREE / DEFER  → no state change here. The deterministic Prediction is created by the
 *                    Signal Engine's own downstream consumer (M4) using the deterministic
 *                    direction; the caller records the judge_decision + stamps judgeAction on
 *                    the Judge's signal_feature row for §22.
 *   FLIP           → re-invoke planTrade with the Judge's direction. If NO_TRADE the flip is
 *                    REFUSED (§18: "risk gates remain fully deterministic ... never bypass
 *                    them"); the record is downgraded to DEFER with `flipRefusedByPlanner=true`,
 *                    and the deterministic Prediction is created normally.
 *                    On a successful FLIP the caller emits `signal.flipped` so the shadow-
 *                    prediction change (m7-shadow-predictions) can add the deterministic
 *                    shadow alongside.
 *   STAND_ASIDE    → transitionSignal(INVALIDATED); emits `signal.stood_aside`; no real
 *                    Prediction is created.
 *
 * The gate never touches real money (§33 rule 20). It never edits a ScoringConfig weight (§16
 * descriptive-not-prescriptive; §24 hypothesis pipeline is the only path to a weight change).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DomainEvent } from '@tip/domain';
import { createLogger } from '@tip/domain';
import { judgeDecision, scoringConfig, signal, signalFeature, tradingAgent, type Db } from '@tip/database';
import { EVENT_NAMES, QUEUE_NAMES, PRIORITY, type EventBus } from '@tip/events';
import { transitionSignal, type ScoringConfig, type TradingStyle } from '@tip/trading-agents';
import type { AsOfMarketData } from '@tip/evaluation';
import { decide, type JudgeAction } from './gate.js';

const log = createLogger('override-gate');

export interface GateConsumerDeps {
  db: Db;
  bus?: EventBus;
  /**
   * `runFlipPlanner(input) → { ok, direction, setup? }` — injected so the consumer stays free
   * of a direct import of `@tip/planner`, which would create a dependency cycle
   * (agents → planner → evaluation → ... would eventually re-import agents). The wiring layer
   * (`apps/worker`) supplies this by calling `planTrade(...)` under an `AsOfMarketData` view.
   */
  runFlipPlanner: (input: FlipPlannerInput) => Promise<FlipPlannerResult>;
}

export interface FlipPlannerInput {
  readonly signalId: string;
  readonly symbol: string;
  readonly domain: 'perp';
  readonly judgeDirection: string;   // 'LONG' | 'SHORT'
  readonly tradingAgentId: string;
  readonly config: ScoringConfig;
  readonly configVersion: number;
  readonly style: TradingStyle;
  readonly view: AsOfMarketData;
}

export type FlipPlannerResult =
  | { readonly ok: true; readonly direction: string }
  | { readonly ok: false; readonly reason: string };

export interface JudgeEventPayload {
  readonly signalId: string;
  readonly judgeVersion: number;
  readonly judgeDirection: string;
  readonly judgeConfidence: number;
}

/**
 * Process one `judge.evaluation.completed` event. Idempotent — the `judge_decision` PK on
 * `(signalId, judgeVersion)` makes a re-delivered event a DB-level no-op.
 */
export async function handleJudgeEvaluation(
  deps: GateConsumerDeps,
  event: DomainEvent<JudgeEventPayload> | { payload: JudgeEventPayload },
  planViewFor: (signalId: string) => Promise<AsOfMarketData | null>,
): Promise<{ action: JudgeAction; refused: boolean } | null> {
  const p = event.payload;
  if (!p?.signalId) return null;

  const sig = (await deps.db.select().from(signal).where(eq(signal.id, p.signalId)).limit(1))[0];
  if (!sig) return null;
  if (sig.state !== 'ACTIVE' && sig.state !== 'CONSUMED') {
    // A signal already invalidated (e.g. by Risk) is not eligible for override.
    return null;
  }

  const cfgRow = (await deps.db.select().from(scoringConfig)
    .where(and(eq(scoringConfig.tradingAgentId, sig.tradingAgentId), eq(scoringConfig.active, true)))
    .limit(1))[0];
  if (!cfgRow) return null;
  const cfg = cfgRow.config as ScoringConfig;
  const agentRow = (await deps.db.select({ style: tradingAgent.tradingStyle })
    .from(tradingAgent).where(eq(tradingAgent.id, sig.tradingAgentId)).limit(1))[0];
  const style = (agentRow?.style ?? 'day') as TradingStyle;

  const decision = decide({
    detDirection: sig.direction,
    detConfidence: Number(sig.confidence),
    judgeDirection: p.judgeDirection,
    judgeConfidence: p.judgeConfidence,
    config: cfg,
  });

  let action: JudgeAction = decision.action;
  let flipRefused = false;

  // FLIP: rerun the planner in the judge's direction. If it can't produce a TRADE, refuse.
  if (action === 'FLIP') {
    const view = await planViewFor(p.signalId);
    if (!view) {
      // Can't build an as-of view for this signal — refuse the flip conservatively.
      action = 'DEFER'; flipRefused = true;
    } else {
      const plan = await deps.runFlipPlanner({
        signalId: p.signalId, symbol: sig.symbol, domain: 'perp',
        judgeDirection: p.judgeDirection, tradingAgentId: sig.tradingAgentId,
        config: cfg, configVersion: cfgRow.version, style, view,
      });
      if (!plan.ok) { action = 'DEFER'; flipRefused = true; }
    }
  }

  // STAND_ASIDE: invalidate the signal, no real Prediction (§36).
  if (action === 'STAND_ASIDE') {
    await transitionSignal(deps.db, p.signalId, 'INVALIDATED');
    if (deps.bus) {
      await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
        type: EVENT_NAMES.SIGNAL_INVALIDATED,
        eventTime: new Date().toISOString(),
        source: 'override-gate',
        payload: { signalId: p.signalId, domain: 'perp', reasons: ['STAND_ASIDE'] },
      }, { priority: PRIORITY.FAST }); // §11 — Judge override drives immediate re-plan
    }
  } else if (action === 'FLIP') {
    if (deps.bus) {
      await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
        type: 'signal.flipped',
        eventTime: new Date().toISOString(),
        source: 'override-gate',
        payload: {
          signalId: p.signalId,
          judgeDirection: p.judgeDirection,
          deterministicDirection: sig.direction,
          configVersion: cfgRow.version,
        },
      }, { priority: PRIORITY.FAST }); // §11 — a flip must re-plan ahead of the analysis backlog
    }
  }

  // Persist the decision (idempotent by PK).
  await deps.db.insert(judgeDecision).values({
    signalId: p.signalId, judgeVersion: p.judgeVersion,
    judgeAction: action,
    detConfidence: String(Number(sig.confidence)),
    judgeConfidence: String(p.judgeConfidence),
    detDirection: sig.direction, judgeDirection: p.judgeDirection,
    gap: String(decision.gap),
    configVersion: cfgRow.version,
    flipRefusedByPlanner: flipRefused,
  }).onConflictDoNothing();

  // Stamp judgeAction on the Judge's signal_feature row (single-row §22 read).
  await deps.db.execute(sql`
    UPDATE signal_feature
       SET features = features || jsonb_build_object('judgeAction', ${action}::text,
                                                     'flipRefusedByPlanner', ${flipRefused}::boolean)
     WHERE signal_id = ${p.signalId} AND agent_key = 'judge' AND agent_version = ${p.judgeVersion}
  `);

  log.info('override-gate decided', { signalId: p.signalId, action, refused: flipRefused, gap: decision.gap });
  return { action, refused: flipRefused };
}
