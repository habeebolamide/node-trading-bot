/**
 * Autopsy runner (§24). Subscribes `prediction.resolved` (planning horizon only). Perp only
 * — memecoin throws with §24 citation. Idempotent by unique(prediction_id) — a re-delivered
 * event does nothing; a retry of a FAILED_LLM row explicitly UPDATEs the same row.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { prediction, tradeAutopsy } from '@tip/database';
import { ValidationError, createLogger } from '@tip/domain';
import { featureTupleFor } from '@tip/evaluation';
import type { DeepSeekClient } from '@tip/llm';
import { callWithLog } from '@tip/llm';
import { buildAutopsyEvidence } from './evidence.js';
import { AUTOPSY_VERSION_CURRENT, currentAutopsyPrompt } from './prompts.js';
import { AutopsyOutput, validateOutcomeFields } from './schema.js';

const log = createLogger('autopsy');

export interface AutopsyRunnerDeps {
  db: Db;
  llm: DeepSeekClient;
}

export interface AutopsyEvent {
  readonly predictionId: string;
  readonly domain: 'perp' | 'memecoin';
  readonly planningHorizon: string;
}

export interface AutopsyResult {
  readonly rowId: string;
  readonly status: 'SUCCESS' | 'FAILED_LLM';
  readonly outcome: 'WIN' | 'LOSS';
  readonly llmCallLogId: string;
}

/** Run one autopsy. Returns null when the prediction is missing or not resolved yet. */
export async function autopsyOne(deps: AutopsyRunnerDeps, evt: AutopsyEvent): Promise<AutopsyResult | null> {
  if (evt.domain !== 'perp') {
    throw new ValidationError('autopsy is perp-only in MVP (§24 memecoin scope — no backtest → no promotion path)');
  }

  const p = (await deps.db.select().from(prediction).where(eq(prediction.id, evt.predictionId)).limit(1))[0];
  if (!p) return null;

  // Assemble the feature tuple the same way m6 outcome sweep does — reuses the mapping.
  const featureTuple = await featureTupleFor(deps.db, p.signalId, 'perp');
  const evidence = await buildAutopsyEvidence(deps.db, evt.predictionId, evt.planningHorizon, featureTuple);
  if (!evidence) return null;

  const prompt = currentAutopsyPrompt();
  const call = await callWithLog(deps.db, deps.llm, {
    system: prompt.system,
    user: prompt.userTemplate(evidence),
    schema: AutopsyOutput,
    maxTokens: 2000,
  }, { agent: 'autopsy', agentVersion: AUTOPSY_VERSION_CURRENT, predictionId: evt.predictionId });

  // Failure path: write a FAILED_LLM row so cost is tracked and a retry can UPDATE in place.
  if (!call.ok) {
    log.warn('autopsy llm failure', { predictionId: evt.predictionId, errorKind: call.errorKind, message: call.message });
    return upsertAutopsyRow(deps.db, {
      predictionId: evt.predictionId, setupId: evidence.setupId, outcome: evidence.outcome,
      failureCategory: null, successFactor: null,
      rootCause: null, explanation: null, contributingFactors: null, agentFailures: null,
      lesson: null, recommendation: null,
      llmCallLogId: call.id, status: 'FAILED_LLM',
    });
  }

  const j = call.value;
  try {
    validateOutcomeFields(j, evidence.outcome);
  } catch (e) {
    // Payload passed Zod but violates WIN/LOSS invariant — treat as INVALID_JSON semantically.
    log.warn('autopsy payload violates WIN/LOSS invariant', { predictionId: evt.predictionId, err: String(e) });
    return upsertAutopsyRow(deps.db, {
      predictionId: evt.predictionId, setupId: evidence.setupId, outcome: evidence.outcome,
      failureCategory: null, successFactor: null,
      rootCause: null, explanation: null, contributingFactors: null, agentFailures: null,
      lesson: null, recommendation: null,
      llmCallLogId: call.id, status: 'FAILED_LLM',
    });
  }

  return upsertAutopsyRow(deps.db, {
    predictionId: evt.predictionId, setupId: evidence.setupId, outcome: evidence.outcome,
    failureCategory: j.failureCategory ?? null,
    successFactor: j.successFactor ?? null,
    rootCause: j.rootCause,
    explanation: j.explanation,
    contributingFactors: j.contributingFactors,
    agentFailures: j.agentFailures,
    lesson: j.lesson,
    recommendation: j.recommendation,
    llmCallLogId: call.id,
    status: 'SUCCESS',
  });
}

interface UpsertInput {
  predictionId: string;
  setupId: string;
  outcome: 'WIN' | 'LOSS';
  rootCause: string | null;
  failureCategory: string | null;
  successFactor: string | null;
  explanation: string | null;
  contributingFactors: unknown;
  agentFailures: unknown;
  lesson: string | null;
  recommendation: string | null;
  llmCallLogId: string;
  status: 'SUCCESS' | 'FAILED_LLM';
}

async function upsertAutopsyRow(db: Db, i: UpsertInput): Promise<AutopsyResult> {
  const rowId = randomUUID();
  const values = {
    id: rowId, predictionId: i.predictionId, setupId: i.setupId,
    outcome: i.outcome, rootCause: i.rootCause,
    failureCategory: i.failureCategory, successFactor: i.successFactor,
    explanation: i.explanation,
    contributingFactors: i.contributingFactors,
    agentFailures: i.agentFailures,
    lesson: i.lesson, recommendation: i.recommendation,
    autopsyVersion: AUTOPSY_VERSION_CURRENT,
    llmCallLogId: i.llmCallLogId,
    status: i.status,
  };
  await db.insert(tradeAutopsy).values(values)
    .onConflictDoUpdate({
      target: tradeAutopsy.predictionId,
      set: {
        rootCause: values.rootCause, failureCategory: values.failureCategory,
        successFactor: values.successFactor, explanation: values.explanation,
        contributingFactors: values.contributingFactors, agentFailures: values.agentFailures,
        lesson: values.lesson, recommendation: values.recommendation,
        llmCallLogId: values.llmCallLogId, status: values.status,
        autopsyVersion: AUTOPSY_VERSION_CURRENT,
      },
    });

  return { rowId, status: i.status, outcome: i.outcome, llmCallLogId: i.llmCallLogId };
}
