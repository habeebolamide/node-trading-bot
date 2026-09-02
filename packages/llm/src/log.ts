/**
 * `callWithLog` — the single call helper every M7 module uses. Wraps `client.complete` and
 * writes ONE `llm_call_log` row per call, success or failure. If you invoke the client without
 * this helper, you skip the ledger and §23's cost-vs-value question stops being answerable.
 */
import { randomUUID } from 'node:crypto';
import { llmCallLog, type Db } from '@tip/database';
import { estimateCost } from './cost.js';
import type { CompleteInput, CompleteResult, DeepSeekClient } from './client.js';

export interface CallMeta {
  readonly agent: string;
  readonly agentVersion: number;
  readonly predictionId?: string;
  readonly signalId?: string;
}

export interface CallLogRow {
  readonly id: string;
  readonly cost: number;
  readonly model: string;
  readonly success: boolean;
  readonly errorKind: string | null;
  readonly latencyMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface CallOk<T> extends CallLogRow {
  readonly ok: true;
  readonly value: T;
}

export interface CallErr extends CallLogRow {
  readonly ok: false;
  readonly value: null;
  readonly message: string;
}

export async function callWithLog<T>(
  db: Db,
  client: DeepSeekClient,
  input: CompleteInput<T>,
  meta: CallMeta,
): Promise<CallOk<T> | CallErr> {
  const result: CompleteResult<T> = await client.complete(input);
  const cost = estimateCost({
    model: result.model,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
  });
  const logId = randomUUID();
  const row = {
    id: logId,
    predictionId: meta.predictionId ?? null,
    signalId: meta.signalId ?? null,
    agent: meta.agent,
    agentVersion: meta.agentVersion,
    model: result.model,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    cost: String(cost),
    latencyMs: result.latencyMs,
    success: result.ok,
    errorKind: result.ok ? null : result.errorKind,
  };
  await db.insert(llmCallLog).values(row);

  const base = {
    id: logId, cost, model: result.model, success: result.ok,
    errorKind: result.ok ? null : result.errorKind,
    latencyMs: result.latencyMs,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
  };
  if (result.ok) return { ...base, ok: true as const, value: result.value };
  return { ...base, ok: false as const, value: null, message: result.message };
}
