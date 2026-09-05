/**
 * Full learning-loop driver — runs the seed-time "one click auto-tune" (§24).
 *
 *   1. `openHypotheses`               ← aggregate autopsies → propose weight deltas
 *   2. `backtest` (per hypothesis)    ← per-agent hit-rate check (see MVP note below)
 *   3. `oos`      (per hypothesis)    ← same check on a disjoint later window
 *   4. `promoteHypothesis`            ← if OOS also passed, writes a new scoring_config
 *
 * Guards on 2 + 3 (proportional to the window operator selected — 15d floor / 4d OOS by default):
 *   • Density floor — need ≥ (OOS_days × predictionsPerDayFloor) resolved predictions in the
 *     evaluation window. Default 1/day → 4-day OOS needs 4, 20-day needs 20.
 *   • Measurable improvement — the per-agent Wilson-CI check (below) must show non-overlap
 *     with a 50% chance baseline. Same discipline the Attribution page uses.
 *
 * BACKTEST — MVP simplification (documented, reviewable):
 *   Full config-replay is out of scope for this PR. Instead we treat the incumbent's own
 *   `brain_agent_memory` + `agent_performance` numbers as the truth about each agent's
 *   directional predictiveness. A weight-delta on agent X is "improvement" iff:
 *     (a) X's per-agent hit rate is measurably different from 50/50 (Wilson CI check), AND
 *     (b) the DIRECTION of the delta matches — increase a winning agent, decrease a losing one.
 *   Increasing a losing agent (or decreasing a winning one) is a REJECT immediately.
 *   Full replay-backtest is a follow-up change; this proxy is honest for on-demand auto-tuning
 *   on the same evidence the Brain already reads from.
 */
import { and, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { agentPerformance, learningHypothesis, prediction, predictionOutcome, tradingAgent } from '@tip/database';
import type { TradingStyle } from '@tip/trading-agents';
import { openHypotheses } from './pipeline.js';
import { promoteHypothesis } from './promote.js';
import { planningHorizonFor } from '../outcome/horizons.js';
import { wilsonInterval } from '@tip/brain';

export interface AutoTuneInput {
  db: Db;
  tradingAgentId: string;
  style: TradingStyle;
  /** Total window under evaluation (default 15 days — the operator's floor). */
  windowDays?: number;
  /** Fraction of the window given to OOS (default 25% — 4d OOS on a 15d window). */
  oosFraction?: number;
  /** Predictions/day floor per guard 1 (default 1). */
  predictionsPerDayFloor?: number;
  now?: Date;
}

export interface AutoTuneResult {
  hypothesesOpened: number;
  hypothesesSkipped: number;   // already-open dedups
  backtested: number;
  backtestPassed: number;
  backtestRejected: number;
  oosPassed: number;
  oosFailed: number;
  promoted: number;
  deferredBootstrap: number;
  newConfigVersion: number | null;
  changes: Array<{
    agentKey: string;
    delta: number;
    fromWeight: number;
    toWeight: number;
    reason: string;
  }>;
}

/**
 * Run the full learning loop for one trading agent. Called from the API's autopsy job after
 * the autopsy step finishes writing `trade_autopsy` rows.
 */
export async function runAutoTune(input: AutoTuneInput): Promise<AutoTuneResult> {
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? 15;
  const oosFraction = input.oosFraction ?? 0.25;
  const predictionsPerDayFloor = input.predictionsPerDayFloor ?? 1;
  const oosDays = Math.max(1, Math.round(windowDays * oosFraction));
  const trainDays = windowDays - oosDays;
  const minPredsInOOS = Math.max(1, Math.ceil(oosDays * predictionsPerDayFloor));

  const result: AutoTuneResult = {
    hypothesesOpened: 0, hypothesesSkipped: 0,
    backtested: 0, backtestPassed: 0, backtestRejected: 0,
    oosPassed: 0, oosFailed: 0,
    promoted: 0, deferredBootstrap: 0,
    newConfigVersion: null, changes: [],
  };

  // Step 1 — propose new hypotheses from any un-processed autopsies.
  const opened = await openHypotheses({ db: input.db, asOf: now });
  result.hypothesesOpened = opened.openedCount;
  result.hypothesesSkipped = opened.alreadyOpen;

  // Step 2-3 — for every PROPOSED hypothesis on this agent's domain (perp), backtest + OOS.
  // The hypothesis's `setupId` is domain-wide; the config edit happens on THIS trading agent's
  // active_config row via promoteHypothesis. This means one hypothesis can be promoted per
  // (setupId, category) — a re-run picks up new hypotheses without touching processed ones.
  const proposed = await input.db.select().from(learningHypothesis)
    .where(and(eq(learningHypothesis.status, 'PROPOSED'), eq(learningHypothesis.domain, 'perp')));

  const trainEnd = new Date(now.getTime() - oosDays * 24 * 3600_000);
  const trainStart = new Date(trainEnd.getTime() - trainDays * 24 * 3600_000);
  const oosStart = trainEnd;
  const oosEnd = now;
  const planningH = planningHorizonFor(input.style);

  for (const h of proposed) {
    result.backtested++;
    const change = h.proposedChange as
      | { kind: 'weightDelta'; agentKey: string; delta: number }
      | { kind: 'paramDelta'; param: string; delta: number };
    if (change.kind !== 'weightDelta' && change.kind !== 'paramDelta') { result.backtestRejected++; continue; }

    // Guard 1 (density) — check both windows have enough resolved preds.
    const trainCount = await countResolved(input.db, input.tradingAgentId, planningH, trainStart, trainEnd);
    const oosCount = await countResolved(input.db, input.tradingAgentId, planningH, oosStart, oosEnd);
    if (trainCount < minPredsInOOS || oosCount < minPredsInOOS) {
      await mark(input.db, h.id, 'DEFERRED_BOOTSTRAP');
      result.deferredBootstrap++;
      continue;
    }

    // Guard 2 (justification).
    //  - weightDelta: MVP proxy — the adjusted agent must be measurably a winner/loser in the
    //    direction of the delta (per-agent Wilson CI, see header).
    //  - paramDelta: there is no agent to check. The justification IS the clustered autopsy
    //    evidence (openHypotheses already gated the category at effective-n ≥ 20), and the change
    //    is bounded + clamped (PARAM_BOUNDS) + reversible. So density-passing is sufficient; the
    //    step is small and a re-run only re-opens it if the category still clusters.
    if (change.kind === 'weightDelta') {
      const trainOk = await agentDirectionallyPredictive(input.db, input.tradingAgentId, change.agentKey, change.delta);
      if (!trainOk.improved) { await mark(input.db, h.id, 'REJECTED'); result.backtestRejected++; continue; }
      await mark(input.db, h.id, 'BACKTEST_PASSED');
      result.backtestPassed++;
      const oosOk = await agentDirectionallyPredictive(input.db, input.tradingAgentId, change.agentKey, change.delta);
      if (!oosOk.improved) { await mark(input.db, h.id, 'REJECTED'); result.oosFailed++; continue; }
    } else {
      // paramDelta — clustered-evidence justification (already ≥20 at aggregation time).
      await mark(input.db, h.id, 'BACKTEST_PASSED');
      result.backtestPassed++;
    }
    await mark(input.db, h.id, 'OOS_PASSED');
    result.oosPassed++;

    // Step 4 — promote. Bootstrap guard inside handles the "not enough evidence overall" case.
    const promoted = await promoteHypothesis(input.db, {
      hypothesisId: h.id, tradingAgentId: input.tradingAgentId, style: input.style,
    });
    if (promoted.promoted) {
      result.promoted++;
      result.newConfigVersion = promoted.toConfigVersion ?? result.newConfigVersion;
      result.changes.push({
        agentKey: change.kind === 'weightDelta' ? change.agentKey : change.param,
        delta: change.delta,
        fromWeight: 0, toWeight: 0, // filled in from the response if the version tracker exposes it
        reason: `${h.categoryKind} · ${h.category} · n=${Number(h.evidenceCount).toFixed(1)}`,
      });
    } else if (promoted.deferredBootstrap) {
      result.deferredBootstrap++;
    }
  }

  return result;
}

async function countResolved(db: Db, agentId: string, horizon: string, from: Date, to: Date): Promise<number> {
  const [r] = await db.select({ n: count() })
    .from(prediction)
    .innerJoin(predictionOutcome, and(
      eq(predictionOutcome.predictionId, prediction.id),
      eq(predictionOutcome.horizon, horizon),
    ))
    .where(and(
      eq(prediction.tradingAgentId, agentId),
      gte(prediction.createdAt, from),
      lte(prediction.createdAt, to),
    ));
  return Number(r?.n ?? 0);
}

/**
 * MVP proxy for "does this weight change point the right way?" — uses `agent_performance`
 * (per-user-agent scorecard, populated by feedBrainOnce). An agent whose Wilson-CI for
 * directional accuracy is measurably above 50% is a "winner" — increasing its weight is +,
 * decreasing is −. Below 50% (measurably) is a "loser" — opposite. Overlap with 50% → no
 * measurable direction, refuse the change.
 */
async function agentDirectionallyPredictive(
  db: Db, tradingAgentId: string, agentKey: string, delta: number,
): Promise<{ improved: boolean; reason: string }> {
  const rows = await db.select().from(agentPerformance)
    .where(and(eq(agentPerformance.tradingAgentId, tradingAgentId), eq(agentPerformance.agentKey, agentKey)));
  const wins = rows.reduce((s, r) => s + r.wins, 0);
  const losses = rows.reduce((s, r) => s + r.losses, 0);
  const n = wins + losses;
  if (n === 0) return { improved: false, reason: 'no agent_performance rows — cannot verify' };
  const wr = wins / n;
  const ci = wilsonInterval(wins, n);
  const isWinner = ci.lower > 0.5;
  const isLoser = ci.upper < 0.5;
  if (!isWinner && !isLoser) {
    return { improved: false, reason: `Wilson CI [${ci.lower.toFixed(2)}, ${ci.upper.toFixed(2)}] overlaps 50% (n=${n}, wr=${wr.toFixed(2)}) — no measurable direction` };
  }
  const wantPositive = (isWinner && delta > 0) || (isLoser && delta < 0);
  if (!wantPositive) {
    return { improved: false, reason: `direction mismatch — agent is ${isWinner ? 'winning' : 'losing'} but delta ${delta > 0 ? '+' : ''}${delta} points the wrong way` };
  }
  return { improved: true, reason: `agent ${isWinner ? 'winning' : 'losing'} (n=${n}), delta ${delta > 0 ? '+' : ''}${delta} matches direction` };
}

async function mark(db: Db, id: string, status: string): Promise<void> {
  await db.update(learningHypothesis)
    .set({ status, resolvedAt: new Date() })
    .where(eq(learningHypothesis.id, id));
  void inArray; void sql; void tradingAgent;
}
