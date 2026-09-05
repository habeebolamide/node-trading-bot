/**
 * DeepSeek client — the ONLY place in this codebase that talks to the DeepSeek API. A
 * `grep -r 'deepseek'` over the repo should show hits only here and in the pricing table.
 *
 * Design contract:
 * - Structured JSON responses only (`response_format: json_object`), Zod-validated on receipt.
 * - Temperature 0 for reproducibility (§32 reproducibility rule extends to LLM calls where the
 *   vendor allows).
 * - Retries on network / 5xx / timeout — NEVER on Zod validation failure. §33 rule 14: invalid
 *   JSON is data the LLM shaped wrong; retrying with the same prompt hides the failure.
 * - 30s default timeout (§18: Judge sits in the hot path; deterministic degrades gracefully).
 */
import type { ZodType } from 'zod';
import { ValidationError, createLogger, type Logger } from '@tip/domain';
import { DEEPSEEK_V4_FLASH } from './cost.js';

const log: Logger = createLogger('llm.client');

export type ErrorKind = 'TIMEOUT' | 'HTTP_5XX' | 'INVALID_JSON' | 'RATE_LIMIT' | 'OTHER';

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface CompleteInput<T> {
  readonly system: string;
  readonly user: string;
  readonly schema: ZodType<T>;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly model?: string;
}

export interface CompleteOk<T> {
  readonly ok: true;
  readonly value: T;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
  readonly model: string;
}

export interface CompleteErr {
  readonly ok: false;
  readonly errorKind: ErrorKind;
  readonly message: string;
  readonly usage: TokenUsage; // zeros when unavailable
  readonly latencyMs: number;
  readonly model: string;
}

export type CompleteResult<T> = CompleteOk<T> | CompleteErr;

export interface DeepSeekClient {
  complete<T>(input: CompleteInput<T>): Promise<CompleteResult<T>>;
}

/**
 * Low-level HTTP fetch abstraction, injectable so tests don't hit the network. Signature
 * matches `fetch` closely — a spy in a test is a two-line mock rather than a full HTTP server.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;             // 'https://api.deepseek.com/v1' by default
  fetchImpl?: FetchLike;
  /** Retry policy — 3 attempts, exponential backoff 200ms / 800ms / 3200ms. */
  maxRetries?: number;
  /** Injectable clock/timer helpers, again for tests. */
  wait?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE = 'https://api.deepseek.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [200, 800, 3200];

interface DeepSeekChatResponse {
  id: string;
  choices: { message: { content: string } }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
  model?: string;
}

/**
 * Refuses to construct without a non-empty API key. Missing key is a startup failure (via
 * `loadConfig` in `@tip/domain`), not a first-call failure — that's what the Zod `.string()` on
 * `DEEPSEEK_API_KEY` in config.ts is for.
 */
export function createDeepSeekClient(opts: ClientOptions): DeepSeekClient {
  if (!opts.apiKey || opts.apiKey.trim() === '') {
    throw new ValidationError('createDeepSeekClient: apiKey is required');
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const maxRetries = opts.maxRetries ?? 3;
  const wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function attempt<T>(input: CompleteInput<T>, model: string, startedAt: number): Promise<CompleteResult<T>> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      const timedOut = err.name === 'AbortError';
      return {
        ok: false,
        errorKind: timedOut ? 'TIMEOUT' : 'OTHER',
        message: err.message ?? String(e),
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: Date.now() - startedAt,
        model,
      };
    } finally {
      clearTimeout(timer);
    }

    // RATE_LIMIT and 5xx are retryable; 4xx (other than 429) is a failure surfaced to the caller.
    if (resp.status >= 500) {
      return {
        ok: false, errorKind: 'HTTP_5XX', message: `HTTP ${resp.status}`,
        usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: Date.now() - startedAt, model,
      };
    }
    if (resp.status === 429) {
      return {
        ok: false, errorKind: 'RATE_LIMIT', message: 'HTTP 429',
        usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: Date.now() - startedAt, model,
      };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return {
        ok: false, errorKind: 'OTHER', message: `HTTP ${resp.status}: ${body.slice(0, 200)}`,
        usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: Date.now() - startedAt, model,
      };
    }

    // Parse + Zod validate. Any failure here is INVALID_JSON — NEVER retried.
    const body = (await resp.json()) as DeepSeekChatResponse;
    const content = body.choices?.[0]?.message?.content ?? '';
    const usage: TokenUsage = {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // Log the raw response on parse failure — the most common cause is truncation
      // (max_tokens hit mid-JSON). Length + head + tail is enough to diagnose without
      // dumping thousands of tokens into the log.
      log.warn('llm invalid JSON — raw response head/tail', {
        model,
        completionTokens: usage.completionTokens,
        contentLength: content.length,
        contentHead: content.slice(0, 300),
        contentTail: content.slice(-300),
      });
      return {
        ok: false, errorKind: 'INVALID_JSON', message: `JSON parse failed: ${String(e).slice(0, 200)}`,
        usage, latencyMs: Date.now() - startedAt, model,
      };
    }
    const check = input.schema.safeParse(parsed);
    if (!check.success) {
      log.warn('llm schema mismatch — parsed but wrong shape', {
        model,
        issues: check.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        parsedHead: JSON.stringify(parsed).slice(0, 400),
      });
      return {
        ok: false, errorKind: 'INVALID_JSON',
        message: `schema: ${check.error.issues.map((i) => i.message).join('; ').slice(0, 200)}`,
        usage, latencyMs: Date.now() - startedAt, model,
      };
    }
    return { ok: true, value: check.data, usage, latencyMs: Date.now() - startedAt, model };
  }

  return {
    async complete<T>(input: CompleteInput<T>): Promise<CompleteResult<T>> {
      const model = input.model ?? DEEPSEEK_V4_FLASH;
      const startedAt = Date.now();
      let last: CompleteResult<T> | null = null;
      for (let i = 0; i <= maxRetries; i++) {
        const result = await attempt(input, model, startedAt);
        if (result.ok) return result;
        last = result;
        // Retry ONLY on network/timeout/5xx/rate limit — schema failures never retry.
        if (result.errorKind === 'INVALID_JSON' || result.errorKind === 'OTHER') return result;
        if (i >= maxRetries) break;
        const delayMs = RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)] ?? 3200;
        log.debug('llm retry', { attempt: i + 1, errorKind: result.errorKind, delayMs });
        await wait(delayMs);
      }
      return last!;
    },
  };
}
