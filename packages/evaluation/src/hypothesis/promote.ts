/**
 * Promotion (§24 verbatim: "A single LLM opinion is never enough — only a backtested,
 * out-of-sample-confirmed improvement gets promoted"). This module writes the NEW
 * `scoring_config` row via `createScoringConfig` from `@tip/trading-agents` — the versioned
 * append-only path. NEVER touches the old row (rule 16).
 *
 * `isBootstrapping` from M6c5 gates promotion: while bootstrapping, status becomes
 * DEFERRED_BOOTSTRAP and a later re-run picks it up. This prevents a weight change that only
 * looked real on the first ~30 predictions.
 */
import { and, eq } from 'drizzle-orm';
import { learningHypothesis, scoringConfig, type Db } from '@tip/database';
import type { ScoringConfig } from '@tip/trading-agents';
import { updateTradingAgentConfig } from '@tip/trading-agents';
import { applyWeightDelta, type ProposedChange } from './propose.js';

export interface PromoteInput {
  readonly hypothesisId: string;
  readonly tradingAgentId: string;
}

export interface PromoteResult {
  readonly promoted: boolean;
  readonly reason: string;
  readonly fromConfigVersion?: number;
  readonly toConfigVersion?: number;
}

/**
 * Promote a hypothesis. Loads the current active `scoring_config` for the tradingAgent,
 * applies the proposed change, inserts a NEW `scoring_config` row via
 * `createScoringConfig` (M4's versioned path — the old row stays untouched, rule 16), and
 * marks the hypothesis PROMOTED.
 */
export async function promoteHypothesis(db: Db, input: PromoteInput): Promise<PromoteResult> {
  const h = (await db.select().from(learningHypothesis).where(eq(learningHypothesis.id, input.hypothesisId)).limit(1))[0];
  if (!h) return { promoted: false, reason: 'hypothesis not found' };
  if (h.status !== 'BACKTEST_PASSED' && h.status !== 'OOS_PENDING') {
    return { promoted: false, reason: `status ${h.status} is not promotable` };
  }
  const active = (await db.select().from(scoringConfig)
    .where(and(eq(scoringConfig.tradingAgentId, input.tradingAgentId), eq(scoringConfig.active, true)))
    .limit(1))[0];
  if (!active) return { promoted: false, reason: 'no active scoring_config for tradingAgent' };

  const current = active.config as ScoringConfig;
  const proposed = h.proposedChange as ProposedChange;
  const newAgentWeights = applyWeightDelta(current.agentWeights ?? {}, proposed);
  const nextConfig: ScoringConfig = { ...current, agentWeights: newAgentWeights };

  // M4's updateTradingAgentConfig bumps version atomically, flips old `active` false, inserts
  // the new active row. Rule 16: old rows stay queryable.
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
    promoted: true, reason: 'promoted with weight delta applied',
    fromConfigVersion: active.version, toConfigVersion: updated.activeConfigVersion,
  };
}
