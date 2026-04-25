import logger from '../utils/logger';
import OpenAI from 'openai';
import {
  EntrySignal,
  ManagementDecision,
  PostMortemResult,
  ClaudeCallResult
} from '../types/claude.types';

// =======================
// CONFIG
// =======================

const MODEL_PRIORITY = [
  "deepseek/deepseek-v4-pro",      // DeepSeek V4 Pro (higher quality)
  "deepseek/deepseek-v4-flash",    // DeepSeek V4 Flash (faster/cheaper)
];

const MAX_RETRIES = 2;

// =======================
// CLIENT - OpenAI Compatible
// =======================

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseURL: 'https://api.deepseek.com/v1',  // DeepSeek API endpoint[citation:2]
});

// =======================
// PUBLIC API
// =======================

export function getEntrySignal(
  systemPrompt: string,
  entryPrompt: string,
  agentId: string,
): Promise<ClaudeCallResult<EntrySignal>> {
  return callWithFallback(systemPrompt, entryPrompt, 'entry', agentId);
}

export function getManagementDecision(
  systemPrompt: string,
  managementPrompt: string,
  agentId: string,
): Promise<ClaudeCallResult<ManagementDecision>> {
  return callWithFallback(systemPrompt, managementPrompt, 'management', agentId);
}

export function getPostMortem(
  postMortemPrompt: string,
  agentId: string,
): Promise<ClaudeCallResult<PostMortemResult>> {
  return callWithFallback(POST_MORTEM_SYSTEM, postMortemPrompt, 'postmortem', agentId);
}

export function getSynthesis(
  synthesisPrompt: string,
  agentId: string,
): Promise<ClaudeCallResult<{ rules: any[] }>> {
  return callWithFallback(SYNTHESIS_SYSTEM, synthesisPrompt, 'synthesis', agentId);
}

// =======================
// CORE ENGINE
// =======================

async function callWithFallback<T>(
  systemPrompt: string,
  userPrompt: string,
  promptType: string,
  agentId: string
): Promise<ClaudeCallResult<T>> {

  const startedAt = Date.now();
  let lastError = '';

  // DeepSeek supports native JSON output - no need for complex parsing hacks![citation:9]
  for (const modelName of MODEL_PRIORITY) {

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {

      try {
        const response = await openai.chat.completions.create({
          model: modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2,
          max_tokens: 2700,
          response_format: { type: "json_object" },  // DeepSeek V4 supports guaranteed JSON output![citation:2][citation:9]
        });

        const rawText = response.choices[0]?.message?.content || '';

        if (!rawText) {
          throw new Error('Empty response from DeepSeek');
        }

        logger.info('📝 DeepSeek raw response preview:', {
          preview: rawText.slice(0, 200),
          fullLength: rawText.length,
        });

        const parsed = parseJSON<T>(rawText);

        if (!parsed.success) {
          throw new Error(parsed.error || 'JSON parsing failed');
        }

        logger.info('✅ DeepSeek success', {
          agentId,
          promptType,
          model: modelName,
          parsedData: parsed.data,
        });

        return buildSuccessResponse(
          parsed.data!, 
          rawText, 
          response, 
          startedAt,
          modelName
        );

      } catch (error: any) {
        lastError = error?.message || 'Unknown error';

        logger.warn(`⚠️ ${modelName} attempt ${attempt + 1} failed`, {
          agentId,
          promptType,
          error: lastError,
        });

        if (attempt < MAX_RETRIES - 1) {
          await sleep(500);
          continue;
        }
      }
    }
  }

  // =======================
  // ALL MODELS FAILED
  // =======================

  logger.error('❌ All DeepSeek models failed', {
    agentId,
    promptType,
    lastError,
  });

  return {
    success: false,
    data: null,
    rawResponse: '',
    tokensUsed: { inputTokens: 0, outputTokens: 0, cacheHits: 0, totalCost: 0 },
    error: lastError,
    durationMs: Date.now() - startedAt,
  };
}

// =======================
// HELPERS
// =======================

function buildSuccessResponse<T>(
  data: T,
  rawText: string,
  response: any,
  startedAt: number,
  modelName: string
): ClaudeCallResult<T> {
  const usage = response.usage || {};
  
  return {
    success: true,
    data,
    rawResponse: rawText,
    tokensUsed: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cacheHits: usage.prompt_cache_hit_tokens ?? 0,  // DeepSeek supports cache hits[citation:2]
      totalCost: 0,  // Calculate based on model if needed
    },
    error: null,
    durationMs: Date.now() - startedAt,
  };
}

function repairJSON(raw: string): string {
  return raw
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();
}

function cleanJson(str: string): string {
  return str
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]")
    .replace(/"\s*:\s*"/g, '":"')
    .trim();
}

function repairTruncatedJSON(raw: string): string {
  let str = raw.trim();

  const opens  = (str.match(/\{/g) ?? []).length;
  const closes = (str.match(/\}/g) ?? []).length;
  const diff   = opens - closes;

  if (diff > 0) {
    const lastBrace = str.lastIndexOf('}');
    const tail      = str.slice(lastBrace + 1);
    const quotes    = (tail.match(/(?<!\\)"/g) ?? []).length;

    if (quotes % 2 !== 0) {
      str += '"';
    }

    const openArrays  = (str.match(/\[/g) ?? []).length;
    const closeArrays = (str.match(/\]/g) ?? []).length;
    str += ']'.repeat(openArrays - closeArrays);
    str += '}'.repeat(diff);
  }

  return str;
}

export function parseJSON<T>(raw: string): {
  success: boolean;
  data:    T | null;
  error:   string | null;
} {
  // 1. Direct parse
  try {
    return { success: true, data: JSON.parse(raw), error: null };
  } catch {}

  // 2. Extract JSON block
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const candidate = cleanJson(match[0]);
      return { success: true, data: JSON.parse(candidate), error: null };
    }
  } catch {}

  // 3. Repair truncated JSON
  try {
    const repaired = repairTruncatedJSON(raw);
    const candidate = cleanJson(repaired);
    const parsed    = JSON.parse(candidate);

    logger.warn('Used truncation repair on DeepSeek response', {
      original: raw.slice(0, 100),
      repaired: repaired.slice(0, 100),
    });

    return { success: true, data: parsed, error: null };
  } catch {}

  return {
    success: false,
    data:    null,
    error:   `No JSON object found. Raw: ${raw.slice(0, 200)}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =======================
// SYSTEM PROMPTS
// =======================

const POST_MORTEM_SYSTEM = `
You are a trading performance analyst.
Analyze losing trades objectively and identify clear patterns.
Return ONLY valid JSON.
`.trim();

const SYNTHESIS_SYSTEM = `
You are an expert at synthesizing trading lessons.
Compress multiple lessons into actionable rules.
Return ONLY valid JSON.
`.trim();