import logger from '../utils/logger';
import { GoogleGenerativeAI } from "@google/generative-ai";
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
  "gemini-3.1-pro-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

const MAX_RETRIES = 2;

// =======================
// CLIENT
// =======================

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

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

  const strictSystemPrompt = `
    ${systemPrompt}

    CRITICAL:
    - Return ONLY valid JSON
    - No markdown, no explanations, no backticks
    - Output must be a single JSON object
    `.trim();

  for (const modelName of MODEL_PRIORITY) {

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {

      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: strictSystemPrompt,
        });

        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 3000,
            responseMimeType: "application/json",
          },
        });

        const response = await result.response;
        const rawText = response.text();

        logger.info(rawText)


        const cleaned = repairJSON(rawText);
        const parsed = parseJSON<T>(cleaned);


        if (!parsed.success) {
          throw new Error(parsed.error || 'JSON parsing failed');
        }

        logger.info('✅ Gemini success', {
          agentId,
          promptType,
          parsedData: parsed.data,
        });

        return buildSuccessResponse(parsed.data!, rawText, response, startedAt);

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
  // ALL GEMINI MODELS FAILED
  // =======================

  logger.error('❌ All Gemini models failed', {
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
  startedAt: number
): ClaudeCallResult<T> {
  return {
    success: true,
    data,
    rawResponse: rawText,
    tokensUsed: {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      cacheHits: 0,
      totalCost: 0,
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
    .replace(/,\s*}/g, "}")      // trailing commas in objects
    .replace(/,\s*]/g, "]")      // trailing commas in arrays
    .replace(/"\s*:\s*"/g, '":"') // normalize spacing
    .trim();
}

function repairTruncatedJSON(raw: string): string {
  let str = raw.trim();

  // Count open braces vs closed
  const opens  = (str.match(/\{/g) ?? []).length;
  const closes = (str.match(/\}/g) ?? []).length;
  const diff   = opens - closes;

  // Add missing closing braces
  if (diff > 0) {
    // First close any open string by adding a quote if needed
    // Check if we're mid-string (odd number of unescaped quotes after last })
    const lastBrace = str.lastIndexOf('}');
    const tail      = str.slice(lastBrace + 1);
    const quotes    = (tail.match(/(?<!\\)"/g) ?? []).length;

    if (quotes % 2 !== 0) {
      str += '"';  // close the open string
    }

    // Close any open array
    const openArrays  = (str.match(/\[/g) ?? []).length;
    const closeArrays = (str.match(/\]/g) ?? []).length;
    str += ']'.repeat(openArrays - closeArrays);

    // Close the open braces
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

    logger.warn('Used truncation repair on Gemini response', {
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