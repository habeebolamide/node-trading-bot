// src/llm/client.ts
import OpenAI from 'openai';
import logger from '../utils/logger';
import { 
  EntrySignal, 
  ManagementDecision, 
  PostMortemResult, 
  ClaudeCallResult 
} from '../types/claude.types';

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Per-call-type model routing.
// Entry needs the strongest reasoning — keep on Anthropic.
// Management / postmortem / synthesis are higher-frequency or batch
// and run against a fixed JSON schema — DeepSeek handles them at ~50x lower cost.
type PromptType = 'entry' | 'management' | 'postmortem' | 'synthesis';

const MODELS_BY_TYPE: Record<PromptType, string[]> = {
  entry: [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
    "google/gemini-2.5-pro",
  ],
  management: [
    "deepseek/deepseek-chat-v3.2",
    "anthropic/claude-sonnet-4-6",
    "google/gemini-2.5-flash",
  ],
  postmortem: [
    "deepseek/deepseek-chat-v3.2",
    "anthropic/claude-sonnet-4-6",
  ],
  synthesis: [
    "deepseek/deepseek-chat-v3.2",
    "anthropic/claude-sonnet-4-6",
  ],
};

const isAnthropicModel = (model: string) => model.startsWith('anthropic/');

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

// ✅ Added back getSynthesis
export async function getSynthesis(
  synthesisPrompt: string,
  agentId: string,
): Promise<ClaudeCallResult<{ rules: any[] }>> {
  return callWithFallback<{ rules: any[] }>(
    SYNTHESIS_SYSTEM, 
    synthesisPrompt, 
    'synthesis', 
    agentId
  );
}

// Rough token estimate — Claude/GPT English text ≈ 3.5 chars/token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

const ANTHROPIC_CACHE_MIN_TOKENS = 1024; // Sonnet/Opus minimum. Haiku = 2048.

// Core function with smart fallback
async function callWithFallback<T>(
  systemPrompt: string,
  userPrompt: string,
  promptType: PromptType,
  agentId: string
): Promise<ClaudeCallResult<T>> {

  const startedAt = Date.now();
  let lastError = '';

  // ── Pre-call size measurement ──
  const sysTokensEst = estimateTokens(systemPrompt);
  const userTokensEst = estimateTokens(userPrompt);

  logger.info('Prompt size (pre-call)', {
    agentId,
    promptType,
    systemChars: systemPrompt.length,
    userChars: userPrompt.length,
    systemTokensEst: sysTokensEst,
    userTokensEst: userTokensEst,
    totalTokensEst: sysTokensEst + userTokensEst,
    systemCacheable: sysTokensEst >= ANTHROPIC_CACHE_MIN_TOKENS,
    systemPaddingNeeded: Math.max(0, ANTHROPIC_CACHE_MIN_TOKENS - sysTokensEst),
  });

  const models = MODELS_BY_TYPE[promptType];

  for (const model of models) {
    let attempt = 0;
    const maxAttemptsPerModel = 2;
    const useCache = isAnthropicModel(model);

    // Anthropic via OpenRouter: send system as a content array so we can attach
    // cache_control. Other providers ignore the array form, so use a plain string.
    const systemMessage = useCache
      ? {
          role: 'system' as const,
          content: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ] as any,
        }
      : { role: 'system' as const, content: systemPrompt };

    while (attempt < maxAttemptsPerModel) {
      try {
        const completion = await openrouter.chat.completions.create({
          model: model,
          messages: [
            systemMessage,
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
        });

        const rawText = completion.choices[0]?.message?.content || '';
        const usage = completion.usage as any;

        // Anthropic cache stats (passed through by OpenRouter on Anthropic calls)
        const cacheReadTokens = usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;

        logger.info('Prompt tokens (actual)', {
          agentId,
          promptType,
          model,
          cacheEnabled: useCache,
          promptTokensActual: usage?.prompt_tokens,
          completionTokensActual: usage?.completion_tokens,
          cacheReadTokens,
          cacheWriteTokens,
          cacheStatus:
            !useCache ? 'disabled'
              : cacheReadTokens > 0 ? 'HIT'
                : cacheWriteTokens > 0 ? 'WRITE'
                  : 'miss',
          systemTokensEst: sysTokensEst,
          userTokensEst: userTokensEst,
          totalTokensEst: sysTokensEst + userTokensEst,
          estimateError: usage?.prompt_tokens
            ? `${(((usage.prompt_tokens - (sysTokensEst + userTokensEst)) / usage.prompt_tokens) * 100).toFixed(1)}%`
            : 'n/a',
        });

        logger.info('Raw Response' , {agentId, promptType,rawText})

        const parsed = parseJSON<T>(rawText);


        logger.info('OpenRouter response details', { agentId, promptType,rawResponse: parsed });

        return {
          success: parsed.success,
          data: parsed.data,
          rawResponse: rawText,
          tokensUsed: {
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
            cacheHits: cacheReadTokens,
            totalCost: 0,
          },
          error: parsed.error,
          durationMs: Date.now() - startedAt,
        };

      } catch (error: any) {
        lastError = error?.message || 'Unknown error';
        attempt++;

        logger.warn(`LLM attempt failed`, {
          agentId,
          promptType,
          model,
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

  logger.error('❌ All LLM models failed', { agentId, promptType, lastError });

  return {
    success: false,
    data: null,
    rawResponse: '',
    tokensUsed: { inputTokens: 0, outputTokens: 0, cacheHits: 0, totalCost: 0 },
    error: lastError || 'All fallback models failed',
    durationMs: Date.now() - startedAt,
  };
}

// JSON Parser
function parseJSON<T>(raw: string): { success: boolean; data: T | null; error: string | null } {
  try {
    // Finds the first '{' and the last '}' regardless of surrounding text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in response");
    
    const data = JSON.parse(jsonMatch[0]) as T;
    return { success: true, data, error: null };
  } catch (e: any) {
    return { success: false, data: null, error: e.message };
  }
}

// System prompts
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