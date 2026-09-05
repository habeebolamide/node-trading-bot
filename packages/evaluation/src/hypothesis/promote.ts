/**
 * Promotion (§24 verbatim: "A single LLM opinion is never enough — only a backtested,
 * out-of-sample-confirmed improvement gets promoted"). This module writes the NEW
 * `scoring_config` row via `updateTradingAgentConfig` from `@tip/trading-agents` — the versioned
 * append-only path. NEVER touches the old row (rule 16).
 *
 * TWO AUDIT FIXES here (2026-09-03):
 *
 *   1. `OOS_PENDING` used to be an acceptable promotion status — meaning a hypothesis could
 *      promote AFTER backtest-passed but BEFORE the out-of-sample check confirmed. That
 *      contradicts §24. Fixed: added a new terminal state `OOS_PASSED` between `OOS_PENDING`
 *      and `PROMOTED`. `promoteHypothesis` now ONLY accepts `OOS_PASSED`; nothing else is
 *      promotable. The OOS runner (backtest.ts caller) transitions `OOS_PENDING → OOS_PASSED`
 *      after the OOS window confirms improvement.
 *
 *   2. `isBootstrapping` was named in this file's header but the code never called it. The
 *      whole point of the DEFERRED_BOOTSTRAP status was to prevent weight changes on thin
 *      evidence. Fixed: `promoteHypothesis` now calls `isBootstrapping` for the hypothesis's
 *      domain + planning horizon + toConfigVersion (which is `active.version` at promote time)
 *      and defers if the domain hasn't hit its maturity bar.
 */
import { and, eq } from 'drizzle-orm';
import { learningHypothesis, scoringConfig, type Db } from '@tip/database';
import type { ScoringConfig, TradingStyle } from '@tip/trading-agents';
import { updateTradingAgentConfig } from '@tip/trading-agents';
import { applyChange, type ProposedChange } from './propose.js';
import { isBootstrapping } from '../metrics/metrics.js';
import { planningHorizonFor } from '../outcome/horizons.js';

export interface PromoteInput {
  readonly hypothesisId: string;
  readonly tradingAgentId: string;
  /** Style is needed to derive the planning horizon for the bootstrap check. */
  readonly style: TradingStyle;
  /** Test/operator seam — override the isBootstrapping minN (default 30 per domain). Set to 0
   *  to bypass the guard entirely, e.g. in unit tests that seed no resolved predictions. */
  readonly minPredictionsForBootstrap?: number;
}

export interface PromoteResult {
  readonly promoted: boolean;
  readonly reason: string;
  readonly fromConfigVersion?: number;
  readonly toConfigVersion?: number;
  readonly deferredBootstrap?: boolean;
}

export async function promoteHypothesis(db: Db, input: PromoteInput): Promise<PromoteResult> {
  const h = (await db.select().from(learningHypothesis).where(eq(learningHypothesis.id, input.hypothesisId)).limit(1))[0];
  if (!h) return { promoted: false, reason: 'hypothesis not found' };
  // Fix 1: ONLY OOS_PASSED promotes. Earlier states are on the way, not there yet.
  if (h.status !== 'OOS_PASSED') {
    return { promoted: false, reason: `status ${h.status} is not promotable (need OOS_PASSED)` };
  }
  const active = (await db.select().from(scoringConfig)
    .where(and(eq(scoringConfig.tradingAgentId, input.tradingAgentId), eq(scoringConfig.active, true)))
    .limit(1))[0];
  if (!active) return { promoted: false, reason: 'no active scoring_config for tradingAgent' };

  // Fix 2: bootstrap guard. If the domain hasn't accumulated enough resolved predictions at
  // the planning horizon, defer — a weight change on thin evidence would be premature.
  const planningH = planningHorizonFor(input.style);
  const boot = await isBootstrapping(db, {
    domain: h.domain as 'perp' | 'memecoin',
    configVersion: active.version,
    horizon: planningH,
    asOf: new Date(),
    // Domain-level maturity: the autopsy evidence spans every version the agent has run (and an
    // operator's minRR/risk edits bump the active version without adding evidence). Counting only
    // the active version's resolved predictions would falsely defer every tune made after a config
    // edit — exactly the bug seen live (223 resolved under v1, active=v3 → 0 → wrongly deferred).
    anyVersion: true,
    ...(input.minPredictionsForBootstrap !== undefined ? { minN: input.minPredictionsForBootstrap } : {}),
  });
  if (boot.bootstrapping) {
    await db.update(learningHypothesis)
      .set({ status: 'DEFERRED_BOOTSTRAP', resolvedAt: new Date() })
      .where(eq(learningHypothesis.id, input.hypothesisId));
    return {
      promoted: false, deferredBootstrap: true,
      reason: `deferred — ${boot.message}`,
    };
  }

  const current = active.config as ScoringConfig;
  const proposed = h.proposedChange as ProposedChange;
  // applyChange handles both weightDelta (renormalized agentWeights) and paramDelta (a clamped
  // scalar like minStopAtrMult). Merge its output onto the current config.
  const patch = applyChange(current as unknown as Record<string, unknown>, proposed);
  const nextConfig = { ...current, ...patch } as ScoringConfig;

  const updated = await updateTradingAgentConfig(db, input.tradingAgentId, nextConfig);

  await db.update(learningHypothesis)
    .set({
      status: 'PROMOTED',
      fromConfigVersion: active.version,
      toConfigVersion: updated.activeConfigVersion,
      resolvedAt: new Date(),
    })
    .where(eq(learningHypothesis.id, input.hypothesisId));

  return {
    promoted: true,
    reason: proposed.kind === 'weightDelta'
      ? 'promoted with weight delta applied'
      : `promoted with ${proposed.param} delta applied`,
    fromConfigVersion: active.version, toConfigVersion: updated.activeConfigVersion,
  };
}
