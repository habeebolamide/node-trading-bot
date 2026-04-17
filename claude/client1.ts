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

// Model priority: Best reasoning → Fast → Backup
const MODEL_PRIORITY = [
  "anthropic/claude-opus-4-6",      // Primary: Best reasoning for entry logic
  "anthropic/claude-sonnet-4-6",    // Secondary: Fast, reliable fallback
  "google/gemini-2.5-pro",    
  "google/gemini-2.5-flash",    // Backup: Extremely fast/low cost
];

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

// Core function with smart fallback
async function callWithFallback<T>(
  systemPrompt: string,
  userPrompt: string,
  promptType: string,
  agentId: string
): Promise<ClaudeCallResult<T>> {

  const startedAt = Date.now();
  let lastError = '';

  for (const model of MODEL_PRIORITY) {
    let attempt = 0;
    const maxAttemptsPerModel = 2;

    while (attempt < maxAttemptsPerModel) {
      try {
        const completion = await openrouter.chat.completions.create({
          model: model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
               
        });

        const rawText = completion.choices[0]?.message?.content || '';
        const usage = completion.usage;

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
            cacheHits: 0,
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