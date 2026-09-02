import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '@tip/domain';
import { createDeepSeekClient, type FetchLike } from './client.js';

const responseSchema = z.object({ answer: z.string(), score: z.number().min(0).max(1) });

function makeResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function chatOk(json: unknown): Response {
  return makeResp({
    id: 'x', choices: [{ message: { content: JSON.stringify(json) } }],
    usage: { prompt_tokens: 12, completion_tokens: 34 }, model: 'deepseek-v4-flash',
  });
}

const noWait = () => Promise.resolve();

describe('createDeepSeekClient', () => {
  it('refuses to construct without an api key (startup failure, not first-call)', () => {
    expect(() => createDeepSeekClient({ apiKey: '' })).toThrow(ValidationError);
    expect(() => createDeepSeekClient({ apiKey: '   ' })).toThrow(ValidationError);
  });

  it('happy path: returns ok, populates usage from vendor response', async () => {
    const fetchImpl = vi.fn(async () => chatOk({ answer: 'hi', score: 0.5 }));
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl, wait: noWait });
    const r = await client.complete({ system: 's', user: 'u', schema: responseSchema });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.answer).toBe('hi');
    expect(r.usage.promptTokens).toBe(12);
    expect(r.usage.completionTokens).toBe(34);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx, succeeds on the third attempt', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(makeResp({ error: 'bad' }, 502))
      .mockResolvedValueOnce(makeResp({ error: 'bad' }, 503))
      .mockResolvedValueOnce(chatOk({ answer: 'ok', score: 0.9 }));
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike, wait: noWait });
    const r = await client.complete({ system: 's', user: 'u', schema: responseSchema });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 (rate limit)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(makeResp({ error: 'rate' }, 429))
      .mockResolvedValueOnce(chatOk({ answer: 'ok', score: 0.1 }));
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike, wait: noWait });
    const r = await client.complete({ system: 's', user: 'u', schema: responseSchema });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after 5xx exhausts retries, returns HTTP_5XX', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResp({}, 500));
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike, wait: noWait, maxRetries: 2 });
    const r = await client.complete({ system: 's', user: 'u', schema: responseSchema });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorKind).toBe('HTTP_5XX');
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('NEVER retries on schema failure — invalid JSON is data the LLM shaped wrong (rule 14)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatOk({ answer: 'ok', score: 2 })); // score > 1 → schema fail
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike, wait: noWait });
    const r = await client.complete({ system: 's', user: 'u', schema: responseSchema });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorKind).toBe('INVALID_JSON');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry
  });

  it('unparseable content is INVALID_JSON, single attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResp({
      id: 'x', choices: [{ message: { content: 'not json at all' } }],
      usage: { prompt_tokens: 5, completion_tokens: 6 }, model: 'deepseek-v4-flash',
    }));
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as FetchLike, wait: noWait });
    const r = await client.complete({ system: 's', user: 'u', schema: responseSchema });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorKind).toBe('INVALID_JSON');
  });

  it('timeout: abort produces errorKind=TIMEOUT', async () => {
    // fetch that never resolves and aborts on signal.
    const fetchImpl: FetchLike = (_url, init) => new Promise((_, reject) => {
      const signal = init.signal as AbortSignal | undefined;
      if (signal) signal.addEventListener('abort', () => {
        const err: Error & { name?: string } = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
    const client = createDeepSeekClient({ apiKey: 'k', fetchImpl, wait: noWait, maxRetries: 0 });
    const r = await client.complete({ system: 's', user: 'u', schema: responseSchema, timeoutMs: 20 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorKind).toBe('TIMEOUT');
  });
});
