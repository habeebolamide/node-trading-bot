import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb, closeDb, llmCallLog, type Db } from '@tip/database';
import { callWithLog } from './log.js';
import { createDeepSeekClient, type FetchLike } from './client.js';

const DATABASE_URL = process.env.DATABASE_URL;
const schema = z.object({ answer: z.string(), score: z.number().min(0).max(1) });

function chatOk(json: unknown): Response {
  return new Response(JSON.stringify({
    id: 'x', choices: [{ message: { content: JSON.stringify(json) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 }, model: 'deepseek-v4-flash',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe.skipIf(!DATABASE_URL)('callWithLog (integration, Postgres)', () => {
  let db: Db;
  const agentTag = `test-llm-${randomUUID().slice(0, 8)}`;

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      // Cleanup any rows this test wrote.
      await db.execute(sql`DELETE FROM llm_call_log WHERE agent = ${agentTag}`);
      await closeDb(db);
    }
  });

  it('SUCCESS: writes ONE llm_call_log row with usage + cost populated', async () => {
    const fetchImpl = vi.fn(async () => chatOk({ answer: 'hi', score: 0.7 }));
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike, wait: () => Promise.resolve() });
    const r = await callWithLog(db, client, { system: 's', user: 'u', schema },
      { agent: agentTag, agentVersion: 1, signalId: randomUUID() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.answer).toBe('hi');

    const rows = await db.select().from(llmCallLog).where(eq(llmCallLog.id, r.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.success).toBe(true);
    expect(rows[0]!.promptTokens).toBe(100);
    expect(rows[0]!.completionTokens).toBe(50);
    expect(Number(rows[0]!.cost)).toBeGreaterThan(0);
    expect(rows[0]!.errorKind).toBeNull();
  });

  it('FAILURE: still writes exactly ONE row, with success=false + errorKind populated', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":"bad"}', { status: 500 }));
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike, wait: () => Promise.resolve(), maxRetries: 1 });
    const r = await callWithLog(db, client, { system: 's', user: 'u', schema },
      { agent: agentTag, agentVersion: 1 });
    expect(r.ok).toBe(false);

    const rows = await db.select().from(llmCallLog).where(eq(llmCallLog.id, r.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.success).toBe(false);
    expect(rows[0]!.errorKind).toBe('HTTP_5XX');
    // Zero usage on failure — retries don't accumulate tokens.
    expect(rows[0]!.promptTokens).toBe(0);
    expect(rows[0]!.completionTokens).toBe(0);
    expect(Number(rows[0]!.cost)).toBe(0);
  });

  it('INVALID_JSON is logged even though the call was not retried', async () => {
    const fetchImpl = vi.fn(async () => chatOk({ answer: 'hi', score: 2.0 })); // score > 1
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike, wait: () => Promise.resolve() });
    const r = await callWithLog(db, client, { system: 's', user: 'u', schema },
      { agent: agentTag, agentVersion: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorKind).toBe('INVALID_JSON');
    const rows = await db.select().from(llmCallLog).where(eq(llmCallLog.id, r.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.errorKind).toBe('INVALID_JSON');
  });

  it('every call → exactly one row (no double-write, no skip on failure paths)', async () => {
    const before = (await db.select({ id: llmCallLog.id }).from(llmCallLog).where(eq(llmCallLog.agent, agentTag))).length;
    const okFetch = vi.fn(async () => chatOk({ answer: 'ok', score: 0.5 }));
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: okFetch as unknown as FetchLike, wait: () => Promise.resolve() });
    for (let i = 0; i < 5; i++) {
      await callWithLog(db, client, { system: 's', user: 'u', schema },
        { agent: agentTag, agentVersion: 1 });
    }
    const after = (await db.select({ id: llmCallLog.id }).from(llmCallLog).where(eq(llmCallLog.agent, agentTag))).length;
    // Each call above added exactly 1 row; the prior tests in this file added 3 more.
    expect(after - before).toBe(5);
  });

  it('signalId and predictionId are captured when supplied', async () => {
    const sigId = randomUUID();
    const predId = randomUUID();
    const fetchImpl = vi.fn(async () => chatOk({ answer: 'hi', score: 0.1 }));
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike, wait: () => Promise.resolve() });

    const withSignal = await callWithLog(db, client, { system: 's', user: 'u', schema },
      { agent: agentTag, agentVersion: 1, signalId: sigId });
    const withPrediction = await callWithLog(db, client, { system: 's', user: 'u', schema },
      { agent: agentTag, agentVersion: 1, predictionId: predId });

    const sRow = (await db.select().from(llmCallLog).where(eq(llmCallLog.id, withSignal.id)))[0]!;
    const pRow = (await db.select().from(llmCallLog).where(eq(llmCallLog.id, withPrediction.id)))[0]!;
    expect(sRow.signalId).toBe(sigId);
    expect(sRow.predictionId).toBeNull();
    expect(pRow.predictionId).toBe(predId);
    expect(pRow.signalId).toBeNull();
    void inArray;
  });
});
