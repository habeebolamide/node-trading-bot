import OpenAI from 'openai';
import logger from '../utils/logger';
import {
  EntrySignal,
  ManagementDecision,
  PostMortemResult,
  ClaudeCallResult,
} from '../types/claude.types';

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

type PromptType = 'entry' | 'management' | 'postmortem' | 'synthesis';

const MODELS_BY_TYPE: Record<PromptType, string[]> = {
  entry: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  management: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  postmortem: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  synthesis: ['deepseek-v4-flash', 'deepseek-v4-pro'],
};

/** DeepSeek disk KV cache only applies to prefixes ≥64 tokens. */
const DEEPSEEK_CACHE_MIN_TOKENS = 64;

type ModelPricing = {
  inputCacheHitPerM: number;
  inputCacheMissPerM: number;
  outputPerM: number;
};

const PRICING_BY_MODEL: Record<string, ModelPricing> = {
  'deepseek-v4-flash': {
    inputCacheHitPerM: 0.0028,
    inputCacheMissPerM: 0.14,
    outputPerM: 0.28,
  },
  'deepseek-v4-pro': {
    inputCacheHitPerM: 0.003625,
    inputCacheMissPerM: 0.435,
    outputPerM: 0.87,
  },
};

const DEFAULT_PRICING = PRICING_BY_MODEL['deepseek-v4-flash'];

export async function getEntrySignal(
  systemPrompt: string,
  entryPrompt: string,
  agentId: string,
): Promise<ClaudeCallResult<EntrySignal>> {
  return callWithFallback<EntrySignal>(systemPrompt, entryPrompt, 'entry', agentId);
}

export async function getManagementDecision(
  systemPrompt: string,
  managementPrompt: string,
  agentId: string,
): Promise<ClaudeCallResult<ManagementDecision>> {
  return callWithFallback<ManagementDecision>(systemPrompt, managementPrompt, 'management', agentId);
}

export async function getPostMortem(
  postMortemPrompt: string,
  agentId: string,
): Promise<ClaudeCallResult<PostMortemResult>> {
  return callWithFallback<PostMortemResult>(POST_MORTEM_SYSTEM, postMortemPrompt, 'postmortem', agentId);
}

export async function getSynthesis(
  synthesisPrompt: string,
  agentId: string,
): Promise<ClaudeCallResult<{ rules: any[] }>> {
  return callWithFallback<{ rules: any[] }>(
    SYNTHESIS_SYSTEM,
    synthesisPrompt,
    'synthesis',
    agentId,
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function pricingFor(model: string): ModelPricing {
  return PRICING_BY_MODEL[model] ?? DEFAULT_PRICING;
}

function estimateCost(
  model: string,
  cacheHitTokens: number,
  cacheMissTokens: number,
  outputTokens: number,
): number {
  const p = pricingFor(model);
  return (
    (cacheHitTokens * p.inputCacheHitPerM +
      cacheMissTokens * p.inputCacheMissPerM +
      outputTokens * p.outputPerM) /
    1_000_000
  );
}

async function callWithFallback<T>(
  systemPrompt: string,
  userPrompt: string,
  promptType: PromptType,
  agentId: string,
): Promise<ClaudeCallResult<T>> {
  const startedAt = Date.now();
  let lastError = '';

  const sysTokensEst = estimateTokens(systemPrompt);
  const userTokensEst = estimateTokens(userPrompt);

  logger.info('Prompt size (pre-call)', {
    agentId,
    promptType,
    provider: 'deepseek',
    systemChars: systemPrompt.length,
    userChars: userPrompt.length,
    systemTokensEst: sysTokensEst,
    userTokensEst: userTokensEst,
    totalTokensEst: sysTokensEst + userTokensEst,
    systemCacheable: sysTokensEst >= DEEPSEEK_CACHE_MIN_TOKENS,
    systemPaddingNeeded: Math.max(0, DEEPSEEK_CACHE_MIN_TOKENS - sysTokensEst),
  });

  const models = MODELS_BY_TYPE[promptType];

  for (const model of models) {
    let attempt = 0;
    const maxAttemptsPerModel = 2;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    while (attempt < maxAttemptsPerModel) {
      try {
        const completion = await deepseek.chat.completions.create({
          model,
          messages,
          temperature: 0.2,
          response_format: { type: 'json_object' },
        });

        const choice = completion.choices?.[0];
        if (!choice) {
          logger.warn('DeepSeek returned no choices', {
            agentId,
            promptType,
            model,
            rawBody: JSON.stringify(completion).slice(0, 500),
          });
          throw new Error('DeepSeek response had no choices array');
        }

        const msg = choice.message as OpenAI.Chat.Completions.ChatCompletionMessage & {
          reasoning_content?: string;
        };
        let rawText = (msg?.content ?? '').trim();
        if (!rawText) rawText = (msg?.reasoning_content ?? '').trim();

        if (!rawText) {
          logger.warn('Empty DeepSeek response', {
            agentId,
            promptType,
            model,
            finishReason: choice.finish_reason,
            messageKeys: msg ? Object.keys(msg) : [],
            messagePreview: JSON.stringify(msg).slice(0, 400),
          });
        }

        const usage = completion.usage as OpenAI.Completions.CompletionUsage & {
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
        };

        const cacheHitTokens = usage?.prompt_cache_hit_tokens ?? 0;
        const cacheMissTokens =
          usage?.prompt_cache_miss_tokens ??
          Math.max(0, (usage?.prompt_tokens ?? 0) - cacheHitTokens);

        const cacheStatus =
          cacheHitTokens > 0 && cacheMissTokens > 0
            ? 'PARTIAL'
            : cacheHitTokens > 0
              ? 'HIT'
              : sysTokensEst >= DEEPSEEK_CACHE_MIN_TOKENS
                ? 'miss'
                : 'below_min_tokens';

        logger.info('Prompt tokens (actual)', {
          agentId,
          promptType,
          model,
          provider: 'deepseek',
          promptTokensActual: usage?.prompt_tokens,
          completionTokensActual: usage?.completion_tokens,
          cacheHitTokens,
          cacheMissTokens,
          cacheStatus,
          systemTokensEst: sysTokensEst,
          userTokensEst: userTokensEst,
          totalTokensEst: sysTokensEst + userTokensEst,
          estimatedCostUsd: estimateCost(
            model,
            cacheHitTokens,
            cacheMissTokens,
            usage?.completion_tokens ?? 0,
          ),
          estimateError: usage?.prompt_tokens
            ? `${(((usage.prompt_tokens - (sysTokensEst + userTokensEst)) / usage.prompt_tokens) * 100).toFixed(1)}%`
            : 'n/a',
        });

        logger.info('Raw Response', { agentId, promptType, rawText });

        const parsed = parseJSON<T>(rawText);

        logger.info('DeepSeek response details', { agentId, promptType, rawResponse: parsed });

        return {
          success: parsed.success,
          data: parsed.data,
          rawResponse: rawText,
          tokensUsed: {
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
            cacheHits: cacheHitTokens,
            totalCost: estimateCost(
              model,
              cacheHitTokens,
              cacheMissTokens,
              usage?.completion_tokens ?? 0,
            ),
          },
          error: parsed.error,
          durationMs: Date.now() - startedAt,
        };
      } catch (error: any) {
        lastError = error?.message || 'Unknown error';
        attempt++;

        logger.warn('LLM attempt failed', {
          agentId,
          promptType,
          model,
          provider: 'deepseek',
          attempt,
          error: lastError.slice(0, 150),
        });

        if (error?.status === 429 || error?.status === 503) {
          await sleep(4000 * attempt);
          continue;
        }

        break;
      }
    }
  }

  logger.error('All DeepSeek models failed', { agentId, promptType, lastError });

  return {
    success: false,
    data: null,
    rawResponse: '',
    tokensUsed: { inputTokens: 0, outputTokens: 0, cacheHits: 0, totalCost: 0 },
    error: lastError || 'All fallback models failed',
    durationMs: Date.now() - startedAt,
  };
}

function parseJSON<T>(raw: string): { success: boolean; data: T | null; error: string | null } {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');

    const data = JSON.parse(jsonMatch[0]) as T;
    return { success: true, data, error: null };
  } catch (e: any) {
    return { success: false, data: null, error: e.message };
  }
}

const POST_MORTEM_SYSTEM = `
You are a trading performance analyst.
Analyze losing trades objectively and identify clear patterns.
Always respond in valid JSON only. Be specific and actionable.
`.trim();

const SYNTHESIS_SYSTEM = `
You are an expert at synthesizing trading lessons.
Compress multiple lessons into the most important, actionable rules.
Always respond in valid JSON only.
`.trim();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
