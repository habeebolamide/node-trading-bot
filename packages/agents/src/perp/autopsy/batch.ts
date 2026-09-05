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
// Compact batch schema is defined inline below — the heavy AutopsyOutput schema (rootCause +
// explanation + arrays + lesson + recommendation) is only used by the single-prediction autopsy
// runner (runner.ts), not this bulk path.

const log = createLogger('autopsy.batch');
/**
 * Sizing (2026-09-05, two rounds):
 *
 *   Round 1 diagnosed via the raw-response log: deepseek-v4-flash burns ~1500-2000 tokens on
 *   internal reasoning before emitting content, and the OLD 8-field schema (rootCause +
 *   explanation ≤2000 + contributingFactors[] + agentFailures[] + lesson + recommendation) made
 *   each item ~1000+ output tokens. 8 items × that + reasoning = >12000 → truncation on every
 *   batch (contentLength 0 or "Unterminated string").
 *
 *   Round 2 (the real fix): the hypothesis pipeline only reads failureCategory/successFactor, so
 *   the schema was slimmed to {predictionId, failureCategory|successFactor, reason} — ~60 tokens
 *   per item instead of 1000+. 8 items now emit ~300-1700 chars of content.
 *
 *   Round 3 (the actual root cause): deepseek-v4-flash is a REASONING model. Its raw response has
 *   a separate `reasoning_content` field, and `reasoning_tokens` count against max_tokens. Live
 *   probe: an 8-item batch reasons 6700-8700 tokens BEFORE emitting content. At the old 12000 cap
 *   reasoning left only ~3300 for content — fine for the compact schema, but the OLD heavy schema
 *   needed ~10000 output → truncated every time. Set max to 16000 so even a reasoning spike leaves
 *   plenty of content room. Also: the prompt MUST contain the literal word "json" (DeepSeek rejects
 *   json_object mode otherwise — "Return ONLY this JSON object" in BATCH_SYSTEM satisfies it).
 */
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_CONCURRENCY = 5;
const BATCH_MAX_TOKENS = 16_000;

/**
 * COMPACT response schema (2026-09-05 rewrite). The old schema demanded 8 heavy fields per item
 * — rootCause, explanation (≤2000 chars!), contributingFactors[], agentFailures[], lesson,
 * recommendation — which for 8 items exploded past the token cap and truncated EVERY batch
 * (see the logs: contentLength 0 or "Unterminated string"). But the hypothesis pipeline only
 * reads `failureCategory` / `successFactor` (aggregate.ts:46) — the rest was write-only decoration.
 *
 * New shape is exactly what the model naturally emits: `{predictionId, failureCategory|
 * successFactor, reason}`. `reason` maps to the DB `rootCause` (+ `explanation` mirror); the
 * heavy columns are nulled. Wrapped in `{results:[...]}` because `response_format:json_object`
 * requires a top-level OBJECT — a bare array is technically out-of-spec and was part of the
 * flakiness.
 */
const BatchAutopsyItem = z.object({
  predictionId: z.string().min(1),
  failureCategory: z.string().max(80).optional(),
  successFactor: z.string().max(80).optional(),
  reason: z.string().min(1).max(400),
});
const BatchAutopsyOutput = z.object({
  results: z.array(BatchAutopsyItem).max(50),
});
type BatchAutopsyItemT = z.infer<typeof BatchAutopsyItem>;

const BATCH_SYSTEM =
`You are the Autopsy analyst — a post-outcome reviewer of trading predictions.

The system already knows WIN vs LOSS as a hard fact (from the Outcome Engine, §21). Your job
is NOT to re-decide. For EACH prediction, classify WHY in ONE short sentence from the evidence.

For a LOSS: set failureCategory to a SHORT_UPPERCASE_TAG like POSITIONING_MISREAD,
REGIME_SHIFTED_MID_TRADE, FUNDING_UNDERWEIGHTED, MOMENTUM_OVERWEIGHTED, LIQUIDATION_SIGNAL_MISSED.
Also use these specific tags when they fit:
- STOP_TOO_TIGHT: price hit the stop and THEN moved the predicted way — the call looked right but
  the stop was inside the noise (a stop-sizing failure, not a direction failure).
- NO_FOLLOW_THROUGH: the market went sideways / rangebound — price never made a real move either
  way and the trade expired flat. The entry fired in chop where there was no move to catch.
- TARGET_TOO_FAR: price moved the predicted way and got MOST of the way to the target, but the
  target was too far to reach in time, so it expired without closing (a target-sizing failure).
- WRONG_FROM_ENTRY: price went adverse immediately with essentially no favorable move — the
  direction was simply wrong from the start.

For a WIN: set successFactor to a tag like MOMENTUM_CONFIRMED_EARLY, REGIME_ALIGNED.

Return ONLY this JSON object (no prose, no markdown):
{"results": [{"predictionId": "<echo>", "failureCategory": "<TAG>" | "successFactor": "<TAG>", "reason": "<one sentence, <=400 chars>"}]}

RULES:
1. Reason ONLY over the evidence given. Do NOT invent prices/funding not present.
2. EVERY input prediction appears exactly ONCE. A LOSS gets failureCategory (no successFactor);
   a WIN gets successFactor (no failureCategory).
3. Unsure? Use failureCategory/successFactor = "UNCLEAR" with a short reason. Never drop a row.
4. Keep every reason to ONE sentence. Brevity matters — long reasons get truncated.`;

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

  // Raw response log (every batch, success or failure). Truncated head/tail so a full autopsy
  // (28 batches × ~5000 chars) doesn't overwhelm logs/api.log while still capturing enough to
  // eyeball what the LLM actually returned. `predictionIds` scopes the batch so grepping by id
  // finds the exact call.
  log.info('autopsy batch llm response', {
    llmCallLogId: call.id,
    size: batch.length,
    ok: call.ok,
    tokensIn, tokensOut, cost,
    contentLength: call.rawContent.length,
    contentHead: call.rawContent.slice(0, 600),
    contentTail: call.rawContent.length > 1200 ? call.rawContent.slice(-600) : '',
    predictionIds: batch.map((b) => b.predictionId),
  });

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
  const byId = new Map<string, BatchAutopsyItemT>();
  for (const it of call.value.results) byId.set(it.predictionId, it);

  let autopsied = 0;
  let failed = 0;
  for (const item of batch) {
    const resp = byId.get(item.predictionId);
    const unclear = resp && (resp.failureCategory === 'UNCLEAR' || resp.successFactor === 'UNCLEAR');
    // Invariant: LOSS must carry failureCategory (not successFactor), WIN vice-versa.
    const invariantOk = resp && !unclear && (item.outcome === 'LOSS'
      ? Boolean(resp.failureCategory) && !resp.successFactor
      : Boolean(resp.successFactor) && !resp.failureCategory);
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
  return `Autopsy these ${batch.length} predictions. Return {"results":[...]} with exactly one element per prediction, echoing predictionId.\n\n${JSON.stringify(payload, null, 2)}`;
}

async function writeSuccessRow(
  db: Db, item: BatchEvidence, j: BatchAutopsyItemT, llmCallLogId: string,
): Promise<void> {
  // Compact schema → DB row. `reason` is the one free-text field; it maps to rootCause (the
  // ≤200-char summary the LLM Review page shows) and mirrors into explanation. The heavy
  // columns (contributingFactors, agentFailures, lesson, recommendation) are nulled — nothing
  // reads them, and demanding them is what exploded the token budget (2026-09-05).
  const rootCause = j.reason.slice(0, 200);
  await db.insert(tradeAutopsy).values({
    id: randomUUID(), predictionId: item.predictionId, setupId: item.setupId,
    outcome: item.outcome,
    rootCause, failureCategory: j.failureCategory ?? null, successFactor: j.successFactor ?? null,
    explanation: j.reason,
    contributingFactors: null, agentFailures: null,
    lesson: null, recommendation: null,
    autopsyVersion: AUTOPSY_VERSION_CURRENT, llmCallLogId, status: 'SUCCESS',
  }).onConflictDoUpdate({
    target: tradeAutopsy.predictionId,
    set: {
      rootCause, failureCategory: j.failureCategory ?? null, successFactor: j.successFactor ?? null,
      explanation: j.reason,
      contributingFactors: null, agentFailures: null,
      lesson: null, recommendation: null,
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
