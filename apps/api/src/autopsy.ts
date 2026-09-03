/**
 * Per-agent bulk autopsy + auto-tune surface (§24 "one click" flow).
 *
 * The operator opens the agent detail → Predictions tab → clicks "Run autopsy". This kicks
 * off an async in-process job that:
 *   1. Autopsies every eligible closed real prediction on this agent (bulk LLM, prediction_id
 *      as the join key). Failed / UNCLEAR / dropped rows persist as `status='FAILED_LLM'`.
 *   2. `openHypotheses` — aggregates the fresh autopsies into candidate weight deltas.
 *   3. Backtests each hypothesis on a proportional window (default 15 days total, 4d OOS).
 *      MVP proxy: uses per-agent hit rates (Wilson CI vs 50%) — see autotune.ts header.
 *   4. Promotes hypotheses that pass both windows to a new `scoring_config` version. Bootstrap
 *      guard inside `promoteHypothesis` defers if the domain isn't mature enough.
 *
 * Same async pattern as the seed/backfill routers — POST returns 202 + jobId; GET polls.
 * In-process registry per (agentId) prevents double-starts.
 */
import { Router } from 'express';
import { and, count, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { Db } from '@tip/database';
import {
  paperPosition, prediction, tradeAutopsy, tradingAgent, type Db as DbType,
} from '@tip/database';
import { createDeepSeekClient } from '@tip/llm';
import { autopsyBulk, type BulkAutopsyProgress } from '@tip/agents';
import { runAutoTune, type AutoTuneResult } from '@tip/evaluation';
import { getTradingAgent, type TradingStyle } from '@tip/trading-agents';

interface AutopsyJob {
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  eligible: number;
  progress: BulkAutopsyProgress;
  autoTune?: AutoTuneResult;
  error?: string;
}

const jobs = new Map<string, AutopsyJob>();

/** Eligible = closed real predictions (has a resolved paper_position or a prediction_outcome
 *  at the planning horizon) with no existing `trade_autopsy` row. */
async function eligiblePredictionIds(db: DbType, agentId: string): Promise<string[]> {
  // Already-autopsied set (any status — a FAILED_LLM row is a persistent skip until retried).
  const doneIds = (await db.select({ id: tradeAutopsy.predictionId }).from(tradeAutopsy)).map((r) => r.id);
  const doneSet = new Set(doneIds);
  // Closed real predictions from a resolved paper_position (fastest live signal), joined by
  // predictionId. Shadows excluded (§24 memecoin note applies to shadow autopsy too — no
  // promotion path for a hypothesis derived from counterfactuals).
  const rows = await db.select({ id: prediction.id })
    .from(prediction)
    .innerJoin(paperPosition, eq(paperPosition.predictionId, prediction.id))
    .where(and(
      eq(prediction.tradingAgentId, agentId),
      eq(prediction.domain, 'perp'),
      eq(prediction.isShadow, false),
      eq(paperPosition.state, 'CLOSED'),
      eq(paperPosition.isShadow, false),
    ));
  // Also include seeded predictions (no paper_position, but have a resolved outcome). Those
  // are the whole point of the seed-time flow.
  const seededRows = await db.execute(sql`
    SELECT p.id
      FROM prediction p
      JOIN prediction_outcome o ON o.prediction_id = p.id
     WHERE p.trading_agent_id = ${agentId}
       AND p.domain = 'perp'
       AND p.is_shadow = false
       AND NOT EXISTS (SELECT 1 FROM paper_position pp WHERE pp.prediction_id = p.id)
     GROUP BY p.id
  `);
  const ids = new Set<string>();
  for (const r of rows) if (!doneSet.has(r.id)) ids.add(r.id);
  for (const r of seededRows as unknown as Iterable<{ id: string }>) if (!doneSet.has(r.id)) ids.add(r.id);
  return [...ids];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void isNull; void notInArray;
}

/** Rough cost estimate — 400 in-tokens + 200 out-tokens per prediction × published $/M. */
function estimateCost(n: number): number {
  const inCost = n * 400 * (0.14 / 1_000_000);
  const outCost = n * 200 * (0.28 / 1_000_000);
  return inCost + outCost;
}

export function autopsyRouter(db: Db, opts: { deepseekApiKey?: string } = {}): Router {
  const r = Router();
  const deepseekApiKey = opts.deepseekApiKey;

  /** Preview — how many are eligible + est. cost, without kicking anything off. */
  r.get('/:id/autopsy/eligible', async (req, res) => {
    const ids = await eligiblePredictionIds(db, req.params.id!);
    res.json({ eligible: ids.length, estimatedCost: estimateCost(ids.length) });
  });

  /** Current job state (or null when nothing has ever run). */
  r.get('/:id/autopsy/status', (req, res) => {
    const j = jobs.get(req.params.id!) ?? null;
    res.json({ job: j });
  });

  /** Kick off the full flow: bulk autopsy → aggregate → backtest → OOS → promote. */
  r.post('/:id/autopsy/run', async (req, res) => {
    const agentId = req.params.id!;
    const agent = await getTradingAgent(db, agentId);
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }
    if (agent.domain !== 'perp') {
      res.status(400).json({ error: 'autopsy is perp-only in MVP (§24 — memecoin has no backtest → no promotion path)' });
      return;
    }
    if (!deepseekApiKey) {
      res.status(503).json({ error: 'DEEPSEEK_API_KEY not configured — autopsy is LLM-driven' });
      return;
    }
    const existing = jobs.get(agentId);
    if (existing?.state === 'running') {
      res.status(409).json({ error: 'an autopsy run is already in progress for this agent' });
      return;
    }

    const ids = await eligiblePredictionIds(db, agentId);
    if (ids.length === 0) {
      res.status(400).json({ error: 'no eligible predictions to autopsy' });
      return;
    }

    const body = (req.body ?? {}) as { windowDays?: number };
    const job: AutopsyJob = {
      state: 'running', startedAt: new Date().toISOString(),
      eligible: ids.length,
      progress: { done: 0, failed: 0, total: ids.length, dollarsSpent: 0 },
    };
    jobs.set(agentId, job);

    void (async () => {
      try {
        const llm = createDeepSeekClient({ apiKey: deepseekApiKey! });
        // Step 1: bulk autopsy — writes trade_autopsy rows (SUCCESS + FAILED_LLM).
        await autopsyBulk({ db, llm }, ids, (p) => { job.progress = p; jobs.set(agentId, { ...job }); });
        // Steps 2-5: aggregate → backtest → OOS → promote (uses the just-written autopsies).
        const autoTune = await runAutoTune({
          db, tradingAgentId: agentId, style: agent.tradingStyle as TradingStyle,
          ...(body.windowDays !== undefined ? { windowDays: body.windowDays } : {}),
        });
        jobs.set(agentId, {
          ...job, state: 'done', finishedAt: new Date().toISOString(), autoTune,
        });
      } catch (err) {
        jobs.set(agentId, {
          ...job, state: 'failed', finishedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    res.status(202).json({ started: true, agentId, eligible: ids.length, estimatedCost: estimateCost(ids.length) });
  });

  return r;
  void count;
}

export function clearAutopsyJobsForTests(): void { jobs.clear(); }
