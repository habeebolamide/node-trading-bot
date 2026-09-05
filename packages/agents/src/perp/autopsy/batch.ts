/**
 * Bulk autopsy driver (§24 — operator "Run Autopsy" button, 2026-09-03).
 *
 * Takes N eligible predictions, sends them in batches of ~25 to the LLM (input array in,
 * structured array out, `prediction_id` as the join key), then writes one `trade_autopsy` row
 * per prediction. Dropped / UNCLEAR / parse-failed rows land as `status='FAILED_LLM'` so the
 * next click's eligibility query skips them (they show up on the "retry failed" surface later).
 *
 * Why batching: DeepSeek V4-Flash's OUTPUT cap is ~8-16k tokens; a single call for 300+
 * predictions structurally cannot return that many autopsy objects. Batches of 25 keep each
 * call ~5k output tokens with lots of headroom, and cap the blast radius when one batch's
 * response is malformed (25 rows get FAILED_LLM, not all 300).
 *
 * Concurrency: 5 batches in flight — 300 predictions ÷ 25 × 1-2s/call ÷ 5 ≈ ~1 minute total.
 * DeepSeek's RPS is well above 5.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '@tip/database';
import { prediction, tradeAutopsy } from '@tip/database';
import { eq, sql } from 'drizzle-orm';
import { createLogger } from '@tip/domain';
import { featureTupleFor } from '@tip/evaluation';
import type { DeepSeekClient } from '@tip/llm';
import { callWithLog } from '@tip/llm';
import { buildAutopsyEvidence, type AutopsyEvidence } from './evidence.js';
import { AUTOPSY_VERSION_CURRENT } from './prompts.js';
import { AutopsyOutput, validateOutcomeFields } from './schema.js';

const log = createLogger('autopsy.batch');
/**
 * Sizing dance (2026-09-05 probe):
 *
 *   deepseek-v4-flash burns ~1500–2000 tokens on internal reasoning BEFORE emitting a single
 *   content byte. The 6000-token cap left ~4000 for actual content, which sounded fine for
 *   12 items × ~450 tokens, but real evidence (agentFailures, contributingFactors, thesis
 *   excerpts) is 3–4× bigger than my sanity-check probe assumed. Every batch consumed 6000
 *   tokens on reasoning + partial output and returned an EMPTY content string (contentLen=0).
 *
 * Fix: raise maxTokens to 12000 (still ~$0.003/batch) and shrink batches to 8. Together this
 * leaves ~10000 tokens for actual output — 5× headroom over the biggest realistic response.
 * The autopsy runner (batchMaxTokens override in runOneBatch) uses the same number.
 */
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_CONCURRENCY = 5;
const BATCH_MAX_TOKENS = 12_000;

/** Response element — echoes back prediction_id so the caller can join. */
const BatchAutopsyItem = AutopsyOutput.extend({
  predictionId: z.string().min(1),
});
const BatchAutopsyOutput = z.array(BatchAutopsyItem).max(50);
type BatchAutopsyOutput = z.infer<typeof BatchAutopsyOutput>;

const BATCH_SYSTEM =
`You are the Autopsy analyst — a post-outcome reviewer of trading predictions.

The system already knows WIN vs LOSS as a hard fact (from the Outcome Engine, §21). Your job
is NOT to re-decide. For EACH prediction you receive, explain WHY, precisely and specifically,
from the evidence provided.

For a LOSS: classify the mechanism with a tag like POSITIONING_MISREAD, REGIME_SHIFTED_MID_TRADE,
FUNDING_UNDERWEIGHTED, MOMENTUM_OVERWEIGHTED, LIQUIDATION_SIGNAL_MISSED (populate failureCategory).

For a WIN: identify what drove it with a tag like MOMENTUM_CONFIRMED_EARLY, REGIME_ALIGNED
(populate successFactor).

RULES:
1. Reason ONLY over the structured evidence. Do NOT invent prices/funding not in the evidence.
2. Return ONLY a JSON array. Each element has \`predictionId\` echoing the input plus the
   autopsy fields. EVERY input prediction MUST appear exactly once in your output.
3. If you cannot confidently tag a prediction, still return an element with predictionId +
   failureCategory or successFactor = "UNCLEAR" and a short reason. Do NOT drop rows.
4. Element cap: at most 50 items per response. If more are given, respond only for as many as
   you can handle and the caller will retry the rest.`;

interface BatchEvidence {
  predictionId: string;
  outcome: 'WIN' | 'LOSS';
  setupId: string;
  evidence: AutopsyEvidence;
}

export interface BulkAutopsyDeps {
  db: Db;
  llm: DeepSeekClient;
  batchSize?: number;
  concurrency?: number;
}

export interface BulkAutopsyProgress {
  done: number;
  failed: number;
  total: number;
  dollarsSpent: number;
}

export interface BulkAutopsyResult {
  autopsied: number;
  failed: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
}

/**
 * Run bulk autopsy over the given prediction ids. Idempotent — a prediction already in
 * `trade_autopsy` (any status) is skipped. Reports progress via the optional `onProgress`
 * callback so the API's status endpoint can show a running bar.
 */
export async function autopsyBulk(
  deps: BulkAutopsyDeps,
  predictionIds: readonly string[],
  onProgress?: (p: BulkAutopsyProgress) => void,
): Promise<BulkAutopsyResult> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  // Assemble evidence for each id (misses skip silently — missing outcomes / positions land as null).
  const evidences: BatchEvidence[] = [];
  for (const id of predictionIds) {
    const p = (await deps.db.select({ signalId: prediction.signalId, horizon: prediction.horizon })
      .from(prediction).where(eq(prediction.id, id)).limit(1))[0];
    if (!p) continue;
    const featureTuple = await featureTupleFor(deps.db, p.signalId, 'perp');
    const evidence = await buildAutopsyEvidence(deps.db, id, p.horizon, featureTuple);
    if (!evidence) continue;
    evidences.push({
      predictionId: id, outcome: evidence.outcome, setupId: evidence.setupId, evidence,
    });
  }

  // Chunk into batches.
  const batches: BatchEvidence[][] = [];
  for (let i = 0; i < evidences.length; i += batchSize) batches.push(evidences.slice(i, i + batchSize));

  const progress: BulkAutopsyProgress = { done: 0, failed: 0, total: evidences.length, dollarsSpent: 0 };
  const result: BulkAutopsyResult = { autopsied: 0, failed: 0, totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 };

  // Simple parallel executor over batches — take `concurrency` in flight at a time.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < batches.length) {
      const b = batches[cursor++]!;
      const outcome = await runOneBatch(deps, b);
      progress.done += outcome.autopsied;
      progress.failed += outcome.failed;
      progress.dollarsSpent += outcome.cost;
      result.autopsied += outcome.autopsied;
      result.failed += outcome.failed;
      result.totalTokensIn += outcome.tokensIn;
      result.totalTokensOut += outcome.tokensOut;
      result.totalCost += outcome.cost;
      onProgress?.(progress);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  return result;
}

interface BatchOutcome {
  autopsied: number; failed: number;
  tokensIn: number; tokensOut: number; cost: number;
}

async function runOneBatch(deps: BulkAutopsyDeps, batch: BatchEvidence[]): Promise<BatchOutcome> {
  const userMessage = buildBatchUserMessage(batch);
  const call = await callWithLog(deps.db, deps.llm, {
    system: BATCH_SYSTEM,
    user: userMessage,
    schema: BatchAutopsyOutput,
    maxTokens: BATCH_MAX_TOKENS,
  }, { agent: 'autopsy', agentVersion: AUTOPSY_VERSION_CURRENT });

  const tokensIn = call.promptTokens;
  const tokensOut = call.completionTokens;
  const cost = call.cost;

  if (!call.ok) {
    // Whole batch failed — write FAILED_LLM for each prediction in this batch.
    log.warn('bulk autopsy batch failed', { size: batch.length, errorKind: call.errorKind, message: call.message });
    for (const item of batch) {
      await writeFailedRow(deps.db, item, call.id);
    }
    return { autopsied: 0, failed: batch.length, tokensIn, tokensOut, cost };
  }

  // Join returned items back to inputs by predictionId. Missing / UNCLEAR / invariant-violating
  // → FAILED_LLM per row so the batch is never all-or-nothing.
  const byId = new Map<string, BatchAutopsyOutput[number]>();
  for (const it of call.value) byId.set(it.predictionId, it);

  let autopsied = 0;
  let failed = 0;
  for (const item of batch) {
    const resp = byId.get(item.predictionId);
    const unclear = resp && (resp.failureCategory === 'UNCLEAR' || resp.successFactor === 'UNCLEAR');
    let invariantOk = false;
    if (resp && !unclear) {
      try { validateOutcomeFields(resp, item.outcome); invariantOk = true; } catch { invariantOk = false; }
    }
    if (!resp || unclear || !invariantOk) {
      await writeFailedRow(deps.db, item, call.id);
      failed++;
      continue;
    }
    await writeSuccessRow(deps.db, item, resp, call.id);
    autopsied++;
  }
  return { autopsied, failed, tokensIn, tokensOut, cost };
}

function buildBatchUserMessage(batch: readonly BatchEvidence[]): string {
  const payload = batch.map((b) => ({
    predictionId: b.predictionId,
    outcome: b.outcome,
    evidence: b.evidence,
  }));
  return `Autopsy ${batch.length} predictions. Return a JSON array with one element per prediction, echoing predictionId.\n\n${JSON.stringify(payload, null, 2)}`;
}

async function writeSuccessRow(
  db: Db, item: BatchEvidence, j: BatchAutopsyOutput[number], llmCallLogId: string,
): Promise<void> {
  await db.insert(tradeAutopsy).values({
    id: randomUUID(), predictionId: item.predictionId, setupId: item.setupId,
    outcome: item.outcome,
    rootCause: j.rootCause, failureCategory: j.failureCategory ?? null, successFactor: j.successFactor ?? null,
    explanation: j.explanation,
    contributingFactors: j.contributingFactors, agentFailures: j.agentFailures,
    lesson: j.lesson, recommendation: j.recommendation,
    autopsyVersion: AUTOPSY_VERSION_CURRENT, llmCallLogId, status: 'SUCCESS',
  }).onConflictDoUpdate({
    target: tradeAutopsy.predictionId,
    set: {
      rootCause: j.rootCause, failureCategory: j.failureCategory ?? null, successFactor: j.successFactor ?? null,
      explanation: j.explanation,
      contributingFactors: j.contributingFactors, agentFailures: j.agentFailures,
      lesson: j.lesson, recommendation: j.recommendation,
      llmCallLogId, status: 'SUCCESS',
    },
  });
}

async function writeFailedRow(db: Db, item: BatchEvidence, llmCallLogId: string): Promise<void> {
  // Update-on-conflict so a re-run refreshes the llmCallLogId + called_at (indirectly, via the
  // fresh row) — otherwise the "why did this fail" trail is stuck on the very first failure.
  // A row already SUCCESS is preserved by the WHERE clause (never downgrade to FAILED_LLM).
  await db.insert(tradeAutopsy).values({
    id: randomUUID(), predictionId: item.predictionId, setupId: item.setupId,
    outcome: item.outcome,
    rootCause: null, failureCategory: null, successFactor: null,
    explanation: null,
    contributingFactors: null, agentFailures: null,
    lesson: null, recommendation: null,
    autopsyVersion: AUTOPSY_VERSION_CURRENT, llmCallLogId, status: 'FAILED_LLM',
  }).onConflictDoUpdate({
    target: tradeAutopsy.predictionId,
    set: { llmCallLogId, status: 'FAILED_LLM' },
    where: sql`${tradeAutopsy.status} <> 'SUCCESS'`,
  });
}
